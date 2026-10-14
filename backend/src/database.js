import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_VERSION = 7

export function resolveDatabasePath(value, backendDirectory) {
  if (!value || value === ':memory:') return value || path.join(backendDirectory, 'data', 'crowzon.sqlite')
  return path.isAbsolute(value) ? value : path.resolve(backendDirectory, value)
}

export function resolveDatabaseDriver(environment = process.env) {
  const configured = (environment.DATABASE_DRIVER ?? (environment.DATABASE_URL ? 'postgres' : 'sqlite')).trim().toLowerCase()
  if (configured === 'postgresql') return 'postgres'
  if (configured !== 'sqlite' && configured !== 'postgres' && configured !== '') {
    throw new Error(`Unsupported DATABASE_DRIVER value: ${environment.DATABASE_DRIVER}. Use sqlite or postgres.`)
  }
  return configured || 'sqlite'
}

export function openDatabase(filename) {
  if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true })
  const database = new DatabaseSync(filename)
  database.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;')

  const currentVersion = database.prepare('PRAGMA user_version').get().user_version
  if (currentVersion > SCHEMA_VERSION) {
    database.close()
    throw new Error(`Database schema version ${currentVersion} is newer than this backend supports.`)
  }

  if (currentVersion < 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
        wallet_address TEXT UNIQUE COLLATE NOCASE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
        description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
        price TEXT NOT NULL,
        category TEXT NOT NULL CHECK (length(category) BETWEEN 1 AND 64),
        seller_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        image_reference TEXT,
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS products_status_created_idx ON products(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id);
      PRAGMA user_version = 1;
      COMMIT;
    `)
  }

  if (currentVersion < 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE products ADD COLUMN chain_id INTEGER;
      ALTER TABLE products ADD COLUMN marketplace_address TEXT COLLATE NOCASE;
      ALTER TABLE products ADD COLUMN listing_id INTEGER;
      CREATE UNIQUE INDEX products_chain_listing_unique
        ON products(chain_id, marketplace_address, listing_id)
        WHERE chain_id IS NOT NULL
          AND marketplace_address IS NOT NULL
          AND listing_id IS NOT NULL;
      PRAGMA user_version = 2;
      COMMIT;
    `)
  }

  if (currentVersion < 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE products ADD COLUMN deployment_id TEXT;
      DROP INDEX products_chain_listing_unique;
      CREATE UNIQUE INDEX products_chain_listing_unique
        ON products(chain_id, marketplace_address, deployment_id, listing_id)
        WHERE chain_id IS NOT NULL
          AND marketplace_address IS NOT NULL
          AND deployment_id IS NOT NULL
          AND listing_id IS NOT NULL;
      PRAGMA user_version = 3;
      COMMIT;
    `)
  }

  if (currentVersion < 4) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE users ADD COLUMN email TEXT;
      ALTER TABLE users ADD COLUMN password_hash TEXT;
      CREATE UNIQUE INDEX users_email_unique
        ON users(email)
        WHERE email IS NOT NULL;
      CREATE TABLE sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
      PRAGMA user_version = 4;
      COMMIT;
    `)
  }

  if (currentVersion < 5) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE indexed_events (
        chain_id INTEGER NOT NULL,
        deployment_id TEXT NOT NULL,
        contract_name TEXT NOT NULL CHECK (contract_name IN ('marketplace', 'escrow')),
        contract_address TEXT NOT NULL COLLATE NOCASE,
        transaction_hash TEXT NOT NULL COLLATE NOCASE,
        log_index INTEGER NOT NULL,
        block_number INTEGER NOT NULL,
        event_name TEXT NOT NULL,
        listing_id TEXT,
        transaction_id TEXT,
        buyer_address TEXT COLLATE NOCASE,
        seller_address TEXT COLLATE NOCASE,
        actor_address TEXT COLLATE NOCASE,
        args_json TEXT NOT NULL,
        PRIMARY KEY (chain_id, deployment_id, transaction_hash, log_index)
      );
      CREATE INDEX indexed_events_order_idx
        ON indexed_events(chain_id, deployment_id, contract_name, transaction_id, block_number, log_index);
      CREATE INDEX indexed_events_listing_idx
        ON indexed_events(chain_id, deployment_id, contract_name, listing_id, block_number, log_index);
      CREATE TABLE indexer_cursors (
        chain_id INTEGER NOT NULL,
        deployment_id TEXT NOT NULL,
        contract_address TEXT NOT NULL COLLATE NOCASE,
        contract_name TEXT NOT NULL CHECK (contract_name IN ('marketplace', 'escrow')),
        cursor_block INTEGER NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (chain_id, deployment_id, contract_address)
      );
      PRAGMA user_version = 5;
      COMMIT;
    `)
  }

  if (currentVersion < 6) {
    database.exec(`
      BEGIN IMMEDIATE;
      DELETE FROM sessions
      WHERE rowid NOT IN (
        SELECT MIN(rowid)
        FROM sessions
        GROUP BY user_id
      );
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_unique
        ON sessions(user_id);
      PRAGMA user_version = 6;
      COMMIT;
    `)
  }

  if (currentVersion < 7) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE users ADD COLUMN assigned_account TEXT COLLATE NOCASE;
      CREATE UNIQUE INDEX users_assigned_account_unique
        ON users(assigned_account)
        WHERE assigned_account IS NOT NULL;
      PRAGMA user_version = 7;
      COMMIT;
    `)
  }

  return database
}
