import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { needsTls } from '@smartrouter/config'
import * as schema from './schema.js'

export function createDb(url: string, opts: { max?: number } = {}) {
  const sql = postgres(url, {
    max: opts.max ?? 10,
    ssl: needsTls(url) ? { rejectUnauthorized: false } : false, // Heroku Postgres uses self-signed certs
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  })
  return { sql, db: drizzle(sql, { schema, casing: 'snake_case' }) }
}

export type Db = ReturnType<typeof createDb>['db']
