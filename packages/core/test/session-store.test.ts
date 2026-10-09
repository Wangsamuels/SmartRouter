/**
 * pgSessionStore must be linearizable: mppx relies on update() for spent/voucher accounting.
 * Needs a Postgres: TEST_DATABASE_URL=postgres://… pnpm test (skipped otherwise).
 */
import { afterAll, describe, expect, it } from 'vitest'
import { createDb } from '@smartrouter/db'
import { pgSessionStore } from '../src/payments-in/store.js'

const url = process.env.TEST_DATABASE_URL
const d = url ? describe : describe.skip

d('pgSessionStore', () => {
  const { db, sql } = createDb(url ?? 'postgres://unused', { max: 10 })
  const store = pgSessionStore(db, { keyPrefix: `test:${Date.now()}:` }) as any
  afterAll(async () => {
    await sql`delete from session_store where key like 'test:%'`
    await sql.end()
  })

  it('round-trips bigints', async () => {
    await store.put('a', { spent: 123456789012345678901n, n: 1 })
    expect(await store.get('a')).toEqual({ spent: 123456789012345678901n, n: 1 })
    await store.delete('a')
    expect(await store.get('a')).toBeNull()
  })

  it('serialises concurrent updates (no lost writes, incl. first write)', async () => {
    await Promise.all(
      Array.from({ length: 40 }, () => store.update('ctr', (cur: { spent: bigint } | null) => ({ op: 'set', value: { spent: (cur?.spent ?? 0n) + 5n }, result: null }))),
    )
    expect(await store.get('ctr')).toEqual({ spent: 200n })
  })

  it('rejects a deduction that would overdraw, under contention', async () => {
    await store.put('ch', { voucher: 100n, spent: 0n })
    const results = await Promise.all(
      Array.from({ length: 30 }, () =>
        store.update('ch', (cur: { voucher: bigint; spent: bigint }) =>
          cur.voucher - cur.spent >= 10n ? { op: 'set', value: { ...cur, spent: cur.spent + 10n }, result: true } : { op: 'noop', result: false },
        ),
      ),
    )
    expect(results.filter(Boolean)).toHaveLength(10)
    expect(await store.get('ch')).toEqual({ voucher: 100n, spent: 100n })
  })

  it('tryClaim records a replay key once', async () => {
    const exp = Date.now() + 60_000
    const r = await Promise.all(Array.from({ length: 10 }, () => store.tryClaim('replay', exp)))
    expect(r.filter(Boolean)).toHaveLength(1)
  })
})
