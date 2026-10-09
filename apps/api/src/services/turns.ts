/**
 * What a model sees for one chat turn: system prompt + (summary) + recent history + the new
 * prompt, sized to the model's budget. Used by /chats/:id/quote (to price it) and /run (to
 * send exactly what was priced).
 */
import { buildContext, estimateTokens, mediaPrompt, type TaskType } from '@smartrouter/core'
import { and, desc, eq, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import type { CatalogModel } from './catalog.js'
import type { TaskInput } from './quotes.js'

export const SYSTEM_PROMPT = 'You are a helpful assistant inside SmartRouter. Answer in the language the user writes in. Be direct and concise unless asked for detail.'
const HISTORY_LIMIT = 200

export type ChatRow = typeof schema.chats.$inferSelect

export async function turnInput(
  ctx: AppContext,
  chat: ChatRow,
  prompt: string,
  model: Pick<CatalogModel, 'payment'> | undefined,
  taskType: TaskType,
  complexity: 'short' | 'long',
): Promise<TaskInput> {
  if (taskType === 'image' || taskType === 'music') {
    const p = mediaPrompt(prompt, chat.summary)
    return { taskType, complexity, prompt: p, rawPrompt: prompt, contextTokens: estimateTokens(p) }
  }
  const history = await ctx.db
    .select({ seq: schema.messages.seq, role: schema.messages.role, content: schema.messages.content })
    .from(schema.messages)
    .where(and(eq(schema.messages.chatId, chat.id), eq(schema.messages.status, 'done')))
    .orderBy(desc(schema.messages.seq))
    .limit(HISTORY_LIMIT)
  const budget = model?.payment === 'free' ? ctx.cfg.free.contextTokens : ctx.cfg.chat.contextTokens
  const built = buildContext({ systemPrompt: SYSTEM_PROMPT, summary: chat.summary, summaryThroughSeq: chat.summaryThroughSeq, history: history.reverse(), prompt, budgetTokens: budget })
  return { taskType, complexity, prompt, rawPrompt: prompt, messages: built.messages, contextTokens: built.contextTokens }
}
