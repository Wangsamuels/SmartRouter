/**
 * Postgres-backed mppx AtomicStore. Holds user channel state (spent, highest voucher,
 * deposit) and replay markers, so every dyno sees the same channel and a voucher can't be
 * double-counted. update(key, fn) runs inside a transaction holding a per-key advisory lock,
 * which also serialises first writes (no row to SELECT … FOR UPDATE yet).
 *
 * Values use ox Json (bigint-aware), the same serialisation as mppx's built-in stores.
 */
import type { Store } from 'mppx'
import { Json } from 'ox'
import { sql, type Db } from '@smartrouter/db'

const LOCK_NS = 4217_0002 // advisory lock namespace for session_store keys

type Row = { value: string }

export function pgSessionStore(db: Db, opts: { keyPrefix?: string } = {}): Store.AtomicStore {
  const k = (key: string) => (opts.keyPrefix ?? '') + key

  const read = async (tx: Pick<Db, 'execute'>, key: string) => {
    const rows = (await tx.execute(sql`select value from session_store where key = ${key}`)) as unknown as Row[]
    return rows[0] ? Json.parse(rows[0].value) : null
  }
  const write = (tx: Pick<Db, 'execute'>, key: string, value: unknown) =>
    tx.execute(sql`insert into session_store (key, value, updated_at) values (${key}, ${Json.stringify(value)}, now())
                   on conflict (key) do update set value = excluded.value, updated_at = now()`)
  const remove = (tx: Pick<Db, 'execute'>, key: string) => tx.execute(sql`delete from session_store where key = ${key}`)
  const lock = (tx: Pick<Db, 'execute'>, key: string) => tx.execute(sql`select pg_advisory_xact_lock(${LOCK_NS}, hashtext(${key}))`)

  const store = {
    async get(key: string) {
      return read(db, k(key))
    },
    async put(key: string, value: unknown) {
      await db.transaction(async (tx) => {
        await lock(tx, k(key))
        await write(tx, k(key), value)
      })
    },
    async delete(key: string) {
      await db.transaction(async (tx) => {
        await lock(tx, k(key))
        await remove(tx, k(key))
      })
    },
    async update(key: string, fn: (current: unknown) => Store.Change<unknown, unknown>) {
      return db.transaction(async (tx) => {
        await lock(tx, k(key))
        const change = fn(await read(tx, k(key)))
        if (change.op === 'set') await write(tx, k(key), change.value)
        else if (change.op === 'delete') await remove(tx, k(key))
        return change.result
      })
    },
    async tryClaim(key: string, expires: number) {
      return db.transaction(async (tx) => {
        await lock(tx, k(key))
        const current = (await read(tx, k(key))) as { type?: string; expires?: number } | null
        if (current !== null && !(current?.type === 'mppx:replay' && typeof current.expires === 'number' && current.expires <= Date.now())) return false
        await write(tx, k(key), { expires, type: 'mppx:replay' })
        return true
      })
    },
  }
  return store as unknown as Store.AtomicStore
}
