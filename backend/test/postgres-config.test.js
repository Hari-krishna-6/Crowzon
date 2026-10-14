import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveDatabaseDriver } from '../src/database.js'
import { resolvePostgresConfig, getPostgresMigrationSql, rewriteSqliteToPostgres } from '../src/postgres.js'

test('defaults to SQLite when no database driver is configured', () => {
  assert.equal(resolveDatabaseDriver({}), 'sqlite')
})

test('rejects invalid database driver values', () => {
  assert.throws(() => resolveDatabaseDriver({ DATABASE_DRIVER: 'mysql' }), /Unsupported DATABASE_DRIVER/)
})

test('requires a PostgreSQL URL when Postgres is selected', () => {
  assert.throws(() => resolvePostgresConfig({ DATABASE_DRIVER: 'postgres' }), /DATABASE_URL is required/)
})

test('includes migration statements for the current application tables', () => {
  const migration = getPostgresMigrationSql()
  assert.match(migration, /CREATE TABLE IF NOT EXISTS users/i)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS products/i)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS sessions/i)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS indexed_events/i)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS assigned_account/i)
  assert.match(migration, /users_assigned_account_unique/i)
})

test('normalizes SQLite transaction and dedupe statements for PostgreSQL', () => {
  assert.equal(
    rewriteSqliteToPostgres("BEGIN IMMEDIATE; INSERT OR IGNORE INTO indexed_events (chain_id) VALUES (?);"),
    'BEGIN; INSERT INTO indexed_events (chain_id) VALUES ($1)',
  )
  assert.match(rewriteSqliteToPostgres("UPDATE products SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"), /CURRENT_TIMESTAMP/)
})
