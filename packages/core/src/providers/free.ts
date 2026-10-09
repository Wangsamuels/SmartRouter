/**
 * The free fallback model, sponsored by SmartRouter (never paid over MPP).
 * Primary: Cloudflare Workers AI. Backup: Groq's free tier (OpenAI-compatible), if a key is set.
 */
import { ProviderError, messagesTokens, type ProviderAdapter, type Task, type TextTask } from './types.js'
import { sseData, textFromChoices, timeoutSignal } from './util.js'

/** Cloudflare bills $0.011 per 1,000 neurons beyond the free daily 10k = 11 micro-USD per neuron. */
export const MICRO_PER_NEURON = 11

// Llama 3.1 8B rates (neurons per token), used to estimate cost before the call.
const NEURONS_IN = 25_608 / 1e6
const NEURONS_OUT = 75_147 / 1e6

export type FreeConfig = {
  cloudflareAccountId?: string
  cloudflareToken?: string
  model: string
  groqKey?: string
  groqModel?: string
}

function asText(task: Task): TextTask {
  if (task.kind !== 'text') throw new ProviderError('the free model is text-only', 'unsupported')
  return task
}

export function estimateFreeCostMicro(task: TextTask): bigint {
  const neurons = messagesTokens(task.messages) * NEURONS_IN + task.maxOutputTokens * NEURONS_OUT
  return BigInt(Math.ceil(neurons * MICRO_PER_NEURON))
}

export function cloudflareAdapter(cfg: FreeConfig, fetchImpl: typeof fetch = fetch): ProviderAdapter {
  async function viaCloudflare(task: TextTask, signal: AbortSignal, onText?: (t: string) => void) {
    if (!cfg.cloudflareAccountId || !cfg.cloudflareToken) throw new ProviderError('Cloudflare Workers AI not configured', 'not_configured')
    const url = `https://api.cloudflare.com/client/v4/accounts/${cfg.cloudflareAccountId}/ai/run/${cfg.model}`
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.cloudflareToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messages: task.messages, max_tokens: task.maxOutputTokens, stream: true }),
      signal: timeoutSignal(signal, 60_000),
    })
    if (!res.ok || !res.body) throw new ProviderError(`cloudflare ${res.status}: ${(await res.text()).slice(0, 200)}`, 'upstream', res.status)
    let text = ''
    let usage: any
    for await (const data of sseData(res.body, signal)) {
      const chunk = JSON.parse(data)
      if (chunk.response) {
        text += chunk.response
        onText?.(chunk.response)
      }
      if (chunk.usage) usage = chunk.usage
    }
    if (!text) throw new ProviderError('empty response from Cloudflare', 'bad_response')
    const neurons = Number(usage?.neurons ?? 0)
    const costMicro = neurons > 0 ? BigInt(Math.ceil(neurons * MICRO_PER_NEURON)) : estimateFreeCostMicro(task)
    return { text, tokensIn: usage?.prompt_tokens, tokensOut: usage?.completion_tokens, costMicro, receipt: `cloudflare:neurons=${neurons.toFixed(2)}` }
  }

  async function viaGroq(task: TextTask, signal: AbortSignal, onText?: (t: string) => void) {
    if (!cfg.groqKey) throw new ProviderError('Groq free tier not configured', 'not_configured')
    const res = await fetchImpl('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.groqKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: cfg.groqModel ?? 'llama-3.1-8b-instant', messages: task.messages, max_tokens: task.maxOutputTokens }),
      signal: timeoutSignal(signal, 30_000),
    })
    const json: any = await res.json().catch(() => ({}))
    if (!res.ok) throw new ProviderError(`groq ${res.status}: ${JSON.stringify(json).slice(0, 200)}`, 'upstream', res.status)
    const out = textFromChoices(json)
    if (!out?.text) throw new ProviderError('empty response from Groq', 'bad_response')
    onText?.(out.text)
    return { ...out, costMicro: 0n, receipt: 'groq-free' }
  }

  return {
    name: 'cloudflare',
    payment: 'free',
    async quote(_model, task) {
      return { costMicro: estimateFreeCostMicro(asText(task)), source: 'free' }
    },
    async run(_model, task, ctx) {
      const t = asText(task)
      let streamed = false
      const onText = (s: string) => {
        streamed = true
        ctx.onText?.(s)
      }
      try {
        const r = await viaCloudflare(t, ctx.signal, onText)
        return { kind: 'text', text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, payment: { paidMicro: r.costMicro, receipts: [r.receipt] } }
      } catch (e) {
        // Fall back to Groq only if nothing reached the user yet (no half answers).
        if (streamed || !cfg.groqKey || ctx.signal.aborted) throw e
        const r = await viaGroq(t, ctx.signal, ctx.onText)
        return { kind: 'text', text: r.text, tokensIn: r.tokensIn, tokensOut: r.tokensOut, payment: { paidMicro: 0n, receipts: [r.receipt] } }
      }
    },
  }
}
