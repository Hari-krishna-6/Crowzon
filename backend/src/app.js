import express from 'express'
import { createHash, randomBytes, scrypt as deriveScrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { openDatabase } from './database.js'
import {
  ApiError,
  parseId,
  validateLogin,
  validateProduct,
  validateRegistration,
  validateUser,
  validateWalletAssociation,
} from './validation.js'

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const DEVELOPMENT_ACCOUNT_CAPACITY = 10
const SESSION_COOKIE = 'crowzon_session'
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000
const scrypt = promisify(deriveScrypt)
const USER_COLUMNS = `
  id, display_name AS "displayName", wallet_address AS "walletAddress",
  assigned_account AS "assignedAccount",
  created_at AS "createdAt", updated_at AS "updatedAt"
`
const AUTH_USER_COLUMNS = `
  users.id, users.display_name AS "displayName", users.email,
  users.wallet_address AS "walletAddress",
  users.assigned_account AS "assignedAccount",
  users.created_at AS "createdAt", users.updated_at AS "updatedAt"
`
const PRODUCT_COLUMNS = `
  id, title, description, price, category,
  seller_id AS sellerId, image_reference AS imageReference,
  status, chain_id AS chainId, marketplace_address AS marketplaceAddress,
  deployment_id AS deploymentId, listing_id AS listingId,
  created_at AS createdAt, updated_at AS updatedAt
`
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function publicUser(user) {
  if (!user) return null
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    walletAddress: user.walletAddress,
    assignedAccount: user.assignedAccount,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  }
}

function cookieToken(request) {
  const cookie = request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
  return cookie?.slice(SESSION_COOKIE.length + 1) ?? ''
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex')
}

async function createSession(database, userId, sessionTtlMs) {
  const token = randomBytes(32).toString('hex')
  const expiresAt = Date.now() + sessionTtlMs
  await database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  await database.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
  await database.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(tokenHash(token), userId, expiresAt)
  return token
}

function sessionCookie(token, maxAge, secure) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

async function hashPassword(password) {
  const salt = randomBytes(16)
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 })
  return `scrypt$16384$${salt.toString('hex')}$${derived.toString('hex')}`
}

async function verifyPassword(password, encoded) {
  const [algorithm, workFactor, saltHex, hashHex] = encoded?.split('$') ?? []
  if (
    algorithm !== 'scrypt' ||
    workFactor !== '16384' ||
    !/^[0-9a-f]{32}$/i.test(saltHex ?? '') ||
    !/^[0-9a-f]{128}$/i.test(hashHex ?? '')
  ) return false
  const expected = Buffer.from(hashHex, 'hex')
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: 16384,
    r: 8,
    p: 1,
  })
  return timingSafeEqual(actual, expected)
}

export function createApp({
  databasePath,
  database,
  sessionTtlMs = SESSION_TTL_MS,
  getDevelopmentAccounts = async () => [],
  getListingSeller = async () => null,
}) {
  const activeDatabase = database ?? openDatabase(databasePath)
  const app = express()
  app.disable('x-powered-by')
  app.locals.closeDatabase = () => activeDatabase.close()
  app.locals.database = activeDatabase
  app.use(express.json({ limit: '32kb', strict: true }))

  const secureCookies = process.env.NODE_ENV === 'production'
  let accountPoolCache = null
  let accountPoolCacheAt = 0
  let allocationQueue = Promise.resolve()

  async function developmentAccountPool() {
    if (accountPoolCache && Date.now() - accountPoolCacheAt < 1000) {
      return accountPoolCache
    }
    let accounts
    try {
      accounts = await getDevelopmentAccounts()
    } catch (error) {
      throw new ApiError(503, `Cannot reach the local Hardhat account pool: ${error.message}`)
    }
    if (!Array.isArray(accounts) || accounts.length < DEVELOPMENT_ACCOUNT_CAPACITY) {
      throw new ApiError(
        503,
        `The local Hardhat RPC must provide at least ${DEVELOPMENT_ACCOUNT_CAPACITY} accounts before user accounts can be assigned.`,
      )
    }
    const pool = accounts.slice(0, DEVELOPMENT_ACCOUNT_CAPACITY).map((account) => {
      if (typeof account !== 'string' || !ADDRESS_PATTERN.test(account)) {
        throw new ApiError(503, 'The local Hardhat RPC returned an invalid development account.')
      }
      return account.toLowerCase()
    })
    if (new Set(pool).size !== DEVELOPMENT_ACCOUNT_CAPACITY) {
      throw new ApiError(503, 'The local Hardhat RPC returned duplicate development accounts.')
    }
    accountPoolCache = pool
    accountPoolCacheAt = Date.now()
    return pool
  }

  function withAllocationLock(operation) {
    const result = allocationQueue.then(operation, operation)
    allocationQueue = result.catch(() => {})
    return result
  }

  async function reconcileAccountAssignments(pool) {
    const users = await activeDatabase.prepare(`
      SELECT id, assigned_account AS "assignedAccount", wallet_address AS "walletAddress"
      FROM users
      ORDER BY id
    `).all()
    if (users.length > pool.length) {
      throw new ApiError(
        409,
        `There are ${users.length} existing users but only ${pool.length} local blockchain accounts. Resolve this capacity conflict before assigning more accounts.`,
      )
    }

    const available = new Set(pool)
    for (const user of users) {
      if (!user.assignedAccount) continue
      const assigned = user.assignedAccount.toLowerCase()
      if (!available.has(assigned)) {
        throw new ApiError(
          409,
          `User ${user.id} is assigned to ${user.assignedAccount}, which is not in the current local Hardhat account pool. The assignment was preserved and not replaced.`,
        )
      }
      available.delete(assigned)
    }

    for (const user of users) {
      if (user.assignedAccount) continue
      const preferred = user.walletAddress?.toLowerCase()
      const assigned = preferred && available.has(preferred)
        ? preferred
        : pool.find((candidate) => available.has(candidate))
      if (!assigned) {
        throw new ApiError(409, 'All 10 local Hardhat accounts are assigned. No account was reused.')
      }
      try {
        const result = await activeDatabase.prepare(`
          UPDATE users SET assigned_account = ? WHERE id = ? AND assigned_account IS NULL
        `).run(assigned, user.id)
        if (result.changes === 1) available.delete(assigned)
      } catch (error) {
        if (error.code !== '23505' && error.code !== 'SQLITE_CONSTRAINT_UNIQUE' && error.errcode !== 2067) {
          throw error
        }
      }
    }

    const assignedUsers = await activeDatabase.prepare(`
      SELECT id, assigned_account AS "assignedAccount" FROM users ORDER BY id
    `).all()
    const assignedSet = new Set()
    for (const user of assignedUsers) {
      const assigned = user.assignedAccount?.toLowerCase()
      if (!assigned || !pool.includes(assigned) || assignedSet.has(assigned)) {
        throw new ApiError(503, 'Could not safely assign unique accounts to every existing Crowzon user.')
      }
      assignedSet.add(assigned)
    }
    return assignedUsers
  }

  async function ensureAccountAssignments() {
    return withAllocationLock(async () => {
      const pool = await developmentAccountPool()
      const users = await reconcileAccountAssignments(pool)
      return { pool, users }
    })
  }

  app.locals.reconcileAccountAssignments = ensureAccountAssignments

  const requireAuth = (request, _response, next) => {
    if (!request.user) {
      next(new ApiError(401, 'Sign in to perform this action.'))
      return
    }
    ensureAccountAssignments().then(({ pool, users }) => {
      const user = users.find((item) => Number(item.id) === Number(request.user.id))
      if (!user || !pool.includes(user.assignedAccount.toLowerCase())) {
        throw new ApiError(503, 'Your assigned local blockchain account is unavailable.')
      }
      request.user.assignedAccount = user.assignedAccount
      next()
    }).catch(next)
  }

  app.use(async (request, response, next) => {
    const token = cookieToken(request)
    if (!/^[0-9a-f]{64}$/i.test(token)) {
      next()
      return
    }
    try {
      const session = await activeDatabase.prepare(`
        SELECT ${AUTH_USER_COLUMNS}, sessions.expires_at AS "expiresAt"
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ?
      `).get(tokenHash(token))
      if (!session || session.expiresAt <= Date.now()) {
        await activeDatabase.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
        response.setHeader('Set-Cookie', sessionCookie('', 0, secureCookies))
        next()
        return
      }
      request.user = publicUser(session)
      next()
    } catch (error) {
      next(error)
    }
  })

  app.use('/api/auth', (_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store')
    next()
  })

  app.get('/api/health', async (_request, response) => {
    await activeDatabase.prepare('SELECT 1').get()
    response.json({ status: 'ok', database: 'connected' })
  })

  app.post('/api/auth/register', async (request, response, next) => {
    try {
      const { displayName, email, password } = validateRegistration(request.body)
      const passwordHash = await hashPassword(password)
      const user = await withAllocationLock(async () => {
        const pool = await developmentAccountPool()
        let created
        for (let attempt = 0; attempt < pool.length; attempt += 1) {
          const users = await reconcileAccountAssignments(pool)
          const used = new Set(users.map((item) => item.assignedAccount.toLowerCase()))
          const assignedAccount = pool.find((candidate) => !used.has(candidate))
          if (!assignedAccount) {
            throw new ApiError(409, 'All 10 local Hardhat accounts are assigned. No account was reused.')
          }
          try {
            const result = await activeDatabase.prepare(`
              INSERT INTO users (display_name, email, password_hash, assigned_account)
              VALUES (?, ?, ?, ?)
            `).run(displayName, email, passwordHash, assignedAccount)
            created = await activeDatabase.prepare(`SELECT ${AUTH_USER_COLUMNS} FROM users WHERE id = ?`)
              .get(Number(result.lastInsertRowid))
            break
          } catch (error) {
            const assignedConflict =
              (error.code === '23505' || error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067) &&
              (error.message?.includes('assigned_account') || error.constraint === 'users_assigned_account_unique')
            if (!assignedConflict) throw error
          }
        }
        if (!created) {
          throw new ApiError(409, 'Could not reserve a unique local blockchain account. Retry registration.')
        }
        const token = await createSession(activeDatabase, created.id, sessionTtlMs)
        return { user: publicUser(created), token }
      })
      response.setHeader('Set-Cookie', sessionCookie(user.token, Math.max(1, Math.ceil(sessionTtlMs / 1000)), secureCookies))
      response.status(201).json({ data: user.user })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/auth/login', async (request, response, next) => {
    try {
      const { email, password } = validateLogin(request.body)
      const user = await activeDatabase.prepare(`
        SELECT ${AUTH_USER_COLUMNS}, password_hash AS passwordHash
        FROM users
        WHERE email = ?
      `).get(email)
      const passwordMatches = user?.passwordHash
        ? await verifyPassword(password, user.passwordHash)
        : (await hashPassword(password), false)
      if (!passwordMatches) throw new ApiError(401, 'Email or password is incorrect.')
      await ensureAccountAssignments()
      const authenticatedUser = await activeDatabase.prepare(`SELECT ${AUTH_USER_COLUMNS} FROM users WHERE id = ?`)
        .get(user.id)
      const token = await createSession(activeDatabase, user.id, sessionTtlMs)
      response.setHeader('Set-Cookie', sessionCookie(token, Math.max(1, Math.ceil(sessionTtlMs / 1000)), secureCookies))
      response.json({ data: publicUser(authenticatedUser) })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/auth/logout', async (request, response, next) => {
    try {
      const token = cookieToken(request)
      if (/^[0-9a-f]{64}$/i.test(token)) {
        await activeDatabase.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token))
      }
      response.setHeader('Set-Cookie', sessionCookie('', 0, secureCookies))
      response.json({ data: { loggedOut: true } })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/auth/me', requireAuth, (request, response) => {
    response.json({ data: request.user })
  })

  app.put('/api/auth/wallet', requireAuth, async (request, response, next) => {
    try {
      const { walletAddress } = validateWalletAssociation(request.body)
      const { pool } = await ensureAccountAssignments()
      if (
        pool.includes(walletAddress) &&
        walletAddress !== request.user.assignedAccount.toLowerCase()
      ) {
        throw new ApiError(403, 'You cannot associate another user’s assigned local blockchain account.')
      }
      await activeDatabase.prepare(`
        UPDATE users SET wallet_address = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(walletAddress, request.user.id)
      const user = await activeDatabase.prepare(`SELECT ${AUTH_USER_COLUMNS} FROM users WHERE users.id = ?`)
        .get(request.user.id)
      response.json({ data: { user: publicUser(user), walletAssociationVerified: false } })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/orders', requireAuth, async (request, response, next) => {
    try {
      if (request.query.walletAddress !== undefined) {
        throw new ApiError(400, 'Order history is scoped to the assigned blockchain account for the authenticated profile.')
      }
      if (!request.user.assignedAccount) {
        throw new ApiError(409, 'Your Crowzon profile has no assigned local blockchain account.')
      }
      const walletAddress = request.user.assignedAccount
      const chainId = Number(request.query.chainId)
      const deploymentId = request.query.deploymentId
      if (
        chainId !== 31337 ||
        !DEPLOYMENT_ID_PATTERN.test(deploymentId ?? '')
      ) {
        throw new ApiError(400, 'A valid local chainId and deploymentId are required.')
      }

      const matchingEvents = await activeDatabase.prepare(`
        SELECT contract_name AS contractName, transaction_hash AS transactionHash,
          log_index AS logIndex, block_number AS blockNumber, event_name AS eventName,
          listing_id AS listingId, transaction_id AS transactionId,
          buyer_address AS buyerAddress, seller_address AS sellerAddress,
          actor_address AS actorAddress, args_json AS argsJson
        FROM indexed_events
        WHERE chain_id = ? AND deployment_id = ? AND contract_name = 'escrow'
          AND (
            buyer_address = ? COLLATE NOCASE OR
            seller_address = ? COLLATE NOCASE OR
            actor_address = ? COLLATE NOCASE
          )
        ORDER BY block_number, log_index
      `).all(chainId, deploymentId.toLowerCase(), walletAddress, walletAddress, walletAddress)
      const groups = new Map()
      for (const event of matchingEvents) {
        if (!event.transactionId) continue
        const transactionId = String(event.transactionId)
        const order = groups.get(transactionId) ?? {
          transactionId,
          listingId: null,
          buyerAddress: null,
          sellerAddress: null,
          complete: false,
          status: null,
          statusSource: 'Read current escrow state from the local contract.',
          events: [],
        }
        const args = JSON.parse(event.argsJson)
        if (event.eventName === 'PurchaseFunded') {
          order.listingId = event.listingId
          order.buyerAddress = event.buyerAddress
          order.sellerAddress = event.sellerAddress
          order.complete = true
        }
        order.events.push({
          contractName: event.contractName,
          name: event.eventName,
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          logIndex: event.logIndex,
          args,
        })
        groups.set(transactionId, order)
      }

      const cursors = await activeDatabase.prepare(`
        SELECT contract_name AS contractName, cursor_block AS cursorBlock
        FROM indexer_cursors
        WHERE chain_id = ? AND deployment_id = ?
      `).all(chainId, deploymentId.toLowerCase())
      response.json({
        data: {
          walletAddress,
          assignedAccount: walletAddress,
          walletAssociationVerified: false,
          orders: [...groups.values()].sort(
            (left, right) => Number(right.transactionId) - Number(left.transactionId),
          ),
          indexer: {
            available: cursors.some((cursor) => cursor.contractName === 'escrow'),
            cursors,
          },
        },
      })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/users', async (request, response, next) => {
    try {
      const walletAddress = request.query.walletAddress
      if (walletAddress !== undefined) {
        const user = validateUser({ displayName: 'placeholder', walletAddress }).walletAddress
        response.json({
          data: await activeDatabase.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE wallet_address = ?`).all(user),
        })
        return
      }
      const users = await activeDatabase.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY id`).all()
      response.json({ data: users })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/users/:id', async (request, response, next) => {
    try {
      const id = parseId(request.params.id)
      const user = await activeDatabase.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).get(id)
      if (!user) throw new ApiError(404, 'User not found.')
      response.json({ data: user })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/products', requireAuth, async (request, response, next) => {
    try {
      const product = validateProduct(request.body)
      if (product.chainId !== undefined) {
        const chainSeller = await getListingSeller(product)
        if (!chainSeller || !ADDRESS_PATTERN.test(chainSeller)) {
          throw new ApiError(503, 'Could not verify the on-chain seller for this listing metadata.')
        }
        if (chainSeller.toLowerCase() !== request.user.assignedAccount.toLowerCase()) {
          throw new ApiError(403, 'You can only associate metadata with a listing created by your assigned blockchain account.')
        }
      }
      const result = await activeDatabase.prepare(`
        INSERT INTO products (
          title, description, price, category, seller_id, image_reference,
          chain_id, marketplace_address, deployment_id, listing_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        product.title,
        product.description,
        product.price,
        product.category,
        request.user.id,
        product.imageReference ?? null,
        product.chainId ?? null,
        product.marketplaceAddress ?? null,
        product.deploymentId ?? null,
        product.listingId ?? null,
      )
      const created = await activeDatabase.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(Number(result.lastInsertRowid))
      response.status(201).json({ data: created })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/products', async (request, response, next) => {
    try {
      const { status } = request.query
      if (status !== undefined && !['ACTIVE', 'INACTIVE'].includes(status)) {
        throw new ApiError(400, 'status must be ACTIVE or INACTIVE.')
      }
      const chainId = request.query.chainId
      const marketplaceAddress = request.query.marketplaceAddress
      const deploymentId = request.query.deploymentId
      const deploymentScopeCount = [chainId, marketplaceAddress, deploymentId]
        .filter((value) => value !== undefined).length
      if (deploymentScopeCount !== 0 && deploymentScopeCount !== 3) {
        throw new ApiError(400, 'chainId, marketplaceAddress, and deploymentId must be provided together.')
      }
      if (
        chainId !== undefined &&
        (Number(chainId) !== 31337 ||
          !ADDRESS_PATTERN.test(marketplaceAddress) ||
          !DEPLOYMENT_ID_PATTERN.test(deploymentId))
      ) {
        throw new ApiError(400, 'A valid local chainId, marketplaceAddress, and deploymentId are required.')
      }
      const conditions = []
      const values = []
      if (status !== undefined) {
        conditions.push('status = ?')
        values.push(status)
      }
      if (chainId !== undefined) {
        conditions.push('chain_id = ?')
        conditions.push('marketplace_address = ?')
        conditions.push('deployment_id = ?')
        values.push(31337, marketplaceAddress.toLowerCase(), deploymentId.toLowerCase())
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
      const products = await activeDatabase.prepare(
        `SELECT ${PRODUCT_COLUMNS} FROM products ${where} ORDER BY created_at DESC, id DESC`,
      ).all(...values)
      response.json({ data: products })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/products/mine', requireAuth, async (request, response, next) => {
    try {
      const products = await activeDatabase.prepare(
        `SELECT ${PRODUCT_COLUMNS} FROM products WHERE seller_id = ? ORDER BY created_at DESC, id DESC`,
      ).all(request.user.id)
      response.json({ data: products })
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/products/:id', async (request, response, next) => {
    try {
      const id = parseId(request.params.id)
      const product = await activeDatabase.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(id)
      if (!product) throw new ApiError(404, 'Product not found.')
      response.json({ data: product })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/products/:id', requireAuth, async (request, response, next) => {
    try {
      const id = parseId(request.params.id)
      const product = validateProduct(request.body, { partial: true })
      const existing = await activeDatabase.prepare('SELECT seller_id AS sellerId FROM products WHERE id = ?').get(id)
      if (!existing) throw new ApiError(404, 'Product not found.')
      if (existing.sellerId !== request.user.id) throw new ApiError(403, 'You can only modify your own product metadata.')
      const columns = {
        title: 'title',
        description: 'description',
        price: 'price',
        category: 'category',
        imageReference: 'image_reference',
        status: 'status',
      }
      const updates = Object.entries(product)
      const assignments = updates.map(([field]) => `${columns[field]} = ?`)
      assignments.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
      const result = await activeDatabase.prepare(`UPDATE products SET ${assignments.join(', ')} WHERE id = ?`)
        .run(...updates.map(([, value]) => value), id)
      if (!result.changes) throw new ApiError(404, 'Product not found.')
      const updated = await activeDatabase.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(id)
      response.json({ data: updated })
    } catch (error) {
      next(error)
    }
  })

  app.post('/api/products/:id/deactivate', requireAuth, async (request, response, next) => {
    try {
      if (request.body && Object.keys(request.body).length) {
        throw new ApiError(400, 'Deactivation does not accept a request body.')
      }
      const id = parseId(request.params.id)
      const existing = await activeDatabase.prepare('SELECT seller_id AS sellerId FROM products WHERE id = ?').get(id)
      if (!existing) throw new ApiError(404, 'Product not found.')
      if (existing.sellerId !== request.user.id) throw new ApiError(403, 'You can only deactivate your own product metadata.')
      const result = await activeDatabase.prepare(`
        UPDATE products
        SET status = 'INACTIVE', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND seller_id = ?
      `).run(id, request.user.id)
      if (!result.changes) throw new ApiError(404, 'Product not found.')
      const updated = await activeDatabase.prepare(`SELECT ${PRODUCT_COLUMNS} FROM products WHERE id = ?`).get(id)
      response.json({ data: updated })
    } catch (error) {
      next(error)
    }
  })

  app.use((_request, _response, next) => next(new ApiError(404, 'Route not found.')))
  app.use((error, _request, response, _next) => {
    if (error instanceof SyntaxError && 'body' in error) {
      response.status(400).json({ error: 'Malformed JSON request body.' })
      return
    }
    if (
      (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067 || error.code === '23505') &&
      (error.message?.includes('products_chain_listing_unique') ||
        error.message?.includes('products.chain_id, products.marketplace_address, products.deployment_id, products.listing_id'))
    ) {
      response.status(409).json({ error: 'Product metadata is already linked to this on-chain listing.' })
      return
    }
    if (
      (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067 || error.code === '23505') &&
      (error.message?.includes('users_email_unique') || error.message?.includes('users.email'))
    ) {
      response.status(409).json({ error: 'An account with that email address already exists.' })
      return
    }
    if (
      (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067 || error.code === '23505') &&
      error.message?.includes('wallet_address')
    ) {
      response.status(409).json({ error: 'That development address is already associated with another profile.' })
      return
    }
    if (
      (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067 || error.code === '23505') &&
      (error.message?.includes('assigned_account') || error.constraint === 'users_assigned_account_unique')
    ) {
      response.status(409).json({ error: 'A local blockchain account was allocated concurrently. Retry registration; no account was reused.' })
      return
    }
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE' || error.errcode === 2067 || error.code === '23505') {
      response.status(409).json({ error: 'A unique account or profile value already exists.' })
      return
    }
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: error.message,
        ...(error.details ? { details: error.details } : {}),
      })
      return
    }
    if (error.type === 'entity.too.large') {
      response.status(413).json({ error: 'Request body exceeds the 32 KB limit.' })
      return
    }
    console.error('Unhandled API error:', error)
    response.status(500).json({ error: 'Internal server error.' })
  })

  return app
}
