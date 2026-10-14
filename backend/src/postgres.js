import { Client, Pool } from 'pg'

export function resolvePostgresConfig(environment = process.env) {
  const driver = (environment.DATABASE_DRIVER ?? (environment.DATABASE_URL ? 'postgres' : 'sqlite')).trim().toLowerCase()
  if (driver && driver !== 'sqlite' && driver !== 'postgres' && driver !== 'postgresql') {
    throw new Error(`Unsupported DATABASE_DRIVER value: ${environment.DATABASE_DRIVER}. Use sqlite or postgres.`)
  }
  const normalizedDriver = driver === 'postgresql' ? 'postgres' : driver || 'sqlite'
  if (normalizedDriver === 'postgres') {
    if (!environment.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when DATABASE_DRIVER=postgres.')
    }
    return {
      driver: 'postgres',
      databaseUrl: environment.DATABASE_URL,
      applicationName: environment.APP_NAME ?? 'crowzon-backend',
    }
  }
  return { driver: 'sqlite', databaseUrl: null }
}

export async function assertPostgresConnection(config) {
  if (!config || config.driver !== 'postgres') {
    return config
  }
  const client = new Client({ connectionString: config.databaseUrl, application_name: config.applicationName })
  try {
    await client.connect()
    await client.query('SELECT 1 AS ok')
    return config
  } finally {
    client.end().catch(() => {})
  }
}

export function getPostgresMigrationSql() {
  return `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      display_name VARCHAR(80) NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
      wallet_address VARCHAR(42) UNIQUE,
      assigned_account VARCHAR(42),
      email VARCHAR(255) UNIQUE,
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      title VARCHAR(120) NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
      price TEXT NOT NULL,
      category VARCHAR(64) NOT NULL CHECK (length(category) BETWEEN 1 AND 64),
      seller_id INTEGER NOT NULL REFERENCES users(id) ON UPDATE CASCADE ON DELETE RESTRICT,
      image_reference TEXT,
      status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
      chain_id INTEGER,
      marketplace_address VARCHAR(42),
      deployment_id VARCHAR(36),
      listing_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT products_chain_listing_unique UNIQUE (chain_id, marketplace_address, deployment_id, listing_id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS indexed_events (
      chain_id INTEGER NOT NULL,
      deployment_id VARCHAR(36) NOT NULL,
      contract_name VARCHAR(16) NOT NULL CHECK (contract_name IN ('marketplace', 'escrow')),
      contract_address VARCHAR(42) NOT NULL,
      transaction_hash VARCHAR(66) NOT NULL,
      log_index INTEGER NOT NULL,
      block_number INTEGER NOT NULL,
      event_name TEXT NOT NULL,
      listing_id TEXT,
      transaction_id TEXT,
      buyer_address VARCHAR(42),
      seller_address VARCHAR(42),
      actor_address VARCHAR(42),
      args_json JSONB NOT NULL,
      PRIMARY KEY (chain_id, deployment_id, transaction_hash, log_index)
    );

    CREATE TABLE IF NOT EXISTS indexer_cursors (
      chain_id INTEGER NOT NULL,
      deployment_id VARCHAR(36) NOT NULL,
      contract_address VARCHAR(42) NOT NULL,
      contract_name VARCHAR(16) NOT NULL CHECK (contract_name IN ('marketplace', 'escrow')),
      cursor_block INTEGER NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (chain_id, deployment_id, contract_address)
    );

    CREATE INDEX IF NOT EXISTS products_status_created_idx ON products(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS products_seller_idx ON products(seller_id);
    CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS indexed_events_order_idx ON indexed_events(chain_id, deployment_id, contract_name, transaction_id, block_number, log_index);
    CREATE INDEX IF NOT EXISTS indexed_events_listing_idx ON indexed_events(chain_id, deployment_id, contract_name, listing_id, block_number, log_index);
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_user_unique ON sessions(user_id);
    ALTER TABLE users ADD COLUMN IF NOT EXISTS assigned_account VARCHAR(42);
    CREATE UNIQUE INDEX IF NOT EXISTS users_assigned_account_unique
      ON users(assigned_account) WHERE assigned_account IS NOT NULL;
  `
}

export async function runPostgresMigrations(environment = process.env) {
  const config = resolvePostgresConfig(environment)
  if (config.driver !== 'postgres') {
    return config
  }
  const client = new Client({ connectionString: config.databaseUrl, application_name: config.applicationName })
  try {
    await client.connect()
    await client.query(getPostgresMigrationSql())
    return config
  } finally {
    client.end().catch(() => {})
  }
}

export function rewriteSqliteToPostgres(sql) {
  let result = sql.trim().replace(/;\s*$/g, '')
  result = result.replace(/\bBEGIN\s+IMMEDIATE\b/gi, 'BEGIN')
  result = result.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, 'INSERT INTO')
  result = result.replace(/COLLATE\s+NOCASE/gi, '')
  result = result.replace(/\bstrftime\s*\(\s*'([^']+)'\s*,\s*'now'\s*\)/gi, 'CURRENT_TIMESTAMP')

  let parameterIndex = 0
  result = result.replace(/\?/g, () => {
    parameterIndex += 1
    return `$${parameterIndex}`
  })

  result = result.replace(/\b([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*\$([0-9]+)\s*\b/g, (match, column, index) => {
    if (!/^\w+(?:\.\w+)?$/.test(column)) return match
    return `LOWER(${column}) = LOWER($${index})`
  })

  result = result.replace(/\b([A-Za-z_][A-Za-z0-9_\.]*)\s*=\s*\$([0-9]+)\s*COLLATE\s+NOCASE\b/gi, (_, column, index) => `LOWER(${column}) = LOWER($${index})`)

  if (/^INSERT\s+INTO/i.test(result) && /ON\s+CONFLICT/i.test(result) === false && /RETURNING/i.test(result) === false) {
    result += ' RETURNING id'
  }
  return result
}

export function openPostgresDatabase(connectionString, options = {}) {
  const pool = new Pool({ connectionString, ...options })

  const prepare = (sql) => {
    const originalSql = sql.trim()
    const normalized = rewriteSqliteToPostgres(sql)
    const insertIgnore = /^INSERT\s+OR\s+IGNORE\s+INTO/i.test(originalSql)
    return {
      async get(...args) {
        const result = await pool.query(normalized, args)
        return result.rows[0]
      },
      async all(...args) {
        const result = await pool.query(normalized, args)
        return result.rows
      },
      async run(...args) {
        if (/^INSERT\s+INTO/i.test(normalized)) {
          try {
            const query = insertIgnore ? normalized : `${normalized} RETURNING id`
            const result = await pool.query(query, args)
            return {
              changes: result.rowCount ?? 0,
              lastInsertRowid: insertIgnore ? null : result.rows[0]?.id ?? null,
            }
          } catch (error) {
            if (insertIgnore && (error.code === '23505' || error.constraint === 'unique')) {
              return { changes: 0, lastInsertRowid: null }
            }
            throw error
          }
        }
        const result = await pool.query(normalized, args)
        return { changes: result.rowCount ?? 0, lastInsertRowid: null }
      },
    }
  }

  return {
    prepare,
    async exec(sql, values = []) {
      const normalized = rewriteSqliteToPostgres(sql)
      if (/^BEGIN\s+/i.test(normalized) || /^COMMIT\b/i.test(normalized) || /^ROLLBACK\b/i.test(normalized)) {
        await pool.query(normalized, values)
        return { changes: 0 }
      }
      const result = await pool.query(normalized, values)
      return { changes: result.rowCount ?? 0 }
    },
    async close() {
      await pool.end()
    },
    async query(sql, values = []) {
      return pool.query(rewriteSqliteToPostgres(sql), values)
    },
  }
}
