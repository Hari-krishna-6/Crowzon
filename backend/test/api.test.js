import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { after, before, beforeEach } from 'node:test'
import { createApp } from '../src/app.js'

let directory
let databasePath
let app
let server
let baseUrl
let testDatabaseSequence = 0
let activeSessionCookie = ''
let listingSellerProvider = async () => testAccounts[0]
const testAccounts = Array.from(
  { length: 10 },
  (_, index) => `0x${(index + 1).toString(16).padStart(40, '0')}`,
)
let developmentAccountProvider = async () => testAccounts

async function startApp() {
  app = createApp({
    databasePath,
    getDevelopmentAccounts: () => developmentAccountProvider(),
    getListingSeller: (...args) => listingSellerProvider(...args),
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
}

async function stopApp() {
  if (!server) return
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  app.locals.closeDatabase()
  server = null
}

async function request(route, options = {}) {
  const { cookie = activeSessionCookie, ...fetchOptions } = options
  const response = await fetch(`${baseUrl}${route}`, {
    ...fetchOptions,
    headers: {
      ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
      ...fetchOptions.headers,
    },
  })
  const body = response.status === 204 ? null : await response.json()
  const setCookie = response.headers.get('set-cookie')
  if (setCookie?.startsWith('crowzon_session=')) {
    activeSessionCookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';', 1)[0]
  }
  return { response, body, cookie: activeSessionCookie }
}

async function createUser(displayName = 'Demo seller', email = `user-${testDatabaseSequence}-${Date.now()}@example.test`) {
  return request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ displayName, email, password: 'correct horse battery staple' }),
  })
}

async function createProduct(_sellerId, overrides = {}, cookie = activeSessionCookie) {
  return request('/api/products', {
    method: 'POST',
    cookie,
    body: JSON.stringify({
      title: 'Handmade mug',
      description: 'A locally stored product listing.',
      price: '6.25',
      category: 'Home & Living',
      imageReference: null,
      ...overrides,
    }),
  })
}

before(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'crowzon-api-test-'))
  databasePath = path.join(directory, 'persistent.sqlite')
})

beforeEach(async () => {
  await stopApp()
  testDatabaseSequence += 1
  activeSessionCookie = ''
  developmentAccountProvider = async () => testAccounts
  listingSellerProvider = async () => testAccounts[0]
  databasePath = path.join(directory, `test-${testDatabaseSequence}.sqlite`)
  await startApp()
})

after(async () => {
  await stopApp()
  await rm(directory, { recursive: true, force: true })
})

test('health reports the initialized database', async () => {
  const { response, body } = await request('/api/health')
  assert.equal(response.status, 200)
  assert.deepEqual(body, { status: 'ok', database: 'connected' })
})

test('registers users, logs in, and never returns password material', async () => {
  const email = 'ada@example.test'
  const created = await createUser('  Ada Seller  ', email)
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.displayName, 'Ada Seller')
  assert.equal(created.body.data.email, email)
  assert.equal(created.body.data.assignedAccount, testAccounts[0])
  assert.equal(JSON.stringify(created.body).includes('password'), false)
  assert.match(created.cookie, /^crowzon_session=[0-9a-f]{64}$/)
  assert.match(created.response.headers.get('set-cookie'), /HttpOnly/)
  assert.match(created.response.headers.get('set-cookie'), /SameSite=Lax/)

  const fetched = await request(`/api/users/${created.body.data.id}`)
  assert.equal(fetched.response.status, 200)
  assert.equal(fetched.body.data.id, created.body.data.id)
  assert.ok(fetched.body.data.createdAt)
  assert.equal(JSON.stringify(fetched.body).includes('password'), false)
  assert.equal(JSON.stringify((await request('/api/users')).body).includes(email), false)

  const duplicate = await createUser('Another profile', email)
  assert.equal(duplicate.response.status, 409)

  const loggedOut = await request('/api/auth/logout', { method: 'POST' })
  assert.equal(loggedOut.response.status, 200)
  const unauthenticated = await request('/api/auth/me')
  assert.equal(unauthenticated.response.status, 401)
  const incorrectPassword = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'incorrect password!' }),
  })
  assert.equal(incorrectPassword.response.status, 401)
  const login = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password: 'correct horse battery staple' }),
  })
  assert.equal(login.response.status, 200)
  assert.equal(login.body.data.id, created.body.data.id)
  assert.equal(login.body.data.assignedAccount, created.body.data.assignedAccount)
  const me = await request('/api/auth/me')
  assert.equal(me.body.data.email, email)
})

test('validates registration and login password lengths consistently', async () => {
  const missing = await request('/api/auth/register', { method: 'POST', body: JSON.stringify({}) })
  assert.equal(missing.response.status, 400)
  const oneCharacterRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'Short Password', email: 'short@example.test', password: 'x' }),
  })
  assert.equal(oneCharacterRegistration.response.status, 201)
  const oneCharacterLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'short@example.test', password: 'x' }),
  })
  assert.equal(oneCharacterLogin.response.status, 200)
  const emptyRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'Empty Password', email: 'empty@example.test', password: '' }),
  })
  assert.equal(emptyRegistration.response.status, 400)
  const emptyLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'short@example.test', password: '' }),
  })
  assert.equal(emptyLogin.response.status, 400)
  const longPassword = 'x'.repeat(129)
  const tooLongRegistration = await request('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ displayName: 'Long Password', email: 'long@example.test', password: longPassword }),
  })
  assert.equal(tooLongRegistration.response.status, 400)
  const tooLongLogin = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'short@example.test', password: longPassword }),
  })
  assert.equal(tooLongLogin.response.status, 400)
  const wrongPassword = await request('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email: 'nobody@example.test', password: 'correct horse battery staple' }),
  })
  assert.equal(wrongPassword.response.status, 401)
})

test('validates profile IDs', async () => {
  const badId = await request('/api/users/0')
  assert.equal(badId.response.status, 400)
  const missingUser = await request('/api/users/999')
  assert.equal(missingUser.response.status, 404)
})

test('assigns unique accounts to concurrent registrations and preserves them after logout and login', async () => {
  const registrations = await Promise.all(
    Array.from({ length: 5 }, (_, index) => request('/api/auth/register', {
      method: 'POST',
      cookie: '',
      body: JSON.stringify({
        displayName: `Concurrent ${index}`,
        email: `concurrent-${index}@example.test`,
        password: 'pw',
      }),
    })),
  )
  assert.ok(registrations.every(({ response }) => response.status === 201))
  const assigned = registrations.map(({ body }) => body.data.assignedAccount)
  assert.equal(new Set(assigned).size, 5)
  assert.ok(assigned.every((address) => testAccounts.includes(address)))

  const user = registrations[0].body.data
  const cookie = registrations[0].cookie
  await request('/api/auth/logout', { method: 'POST', cookie })
  const login = await request('/api/auth/login', {
    method: 'POST',
    cookie: '',
    body: JSON.stringify({ email: user.email, password: 'pw' }),
  })
  assert.equal(login.response.status, 200)
  assert.equal(login.body.data.assignedAccount, user.assignedAccount)
})

test('rejects registration when all ten local accounts are assigned', async () => {
  const registrations = await Promise.all(
    testAccounts.map((_, index) => request('/api/auth/register', {
      method: 'POST',
      cookie: '',
      body: JSON.stringify({
        displayName: `Capacity ${index}`,
        email: `capacity-${index}@example.test`,
        password: 'pw',
      }),
    })),
  )
  assert.ok(registrations.every(({ response }) => response.status === 201))
  const overflow = await request('/api/auth/register', {
    method: 'POST',
    cookie: '',
    body: JSON.stringify({
      displayName: 'Overflow',
      email: 'overflow@example.test',
      password: 'pw',
    }),
  })
  assert.equal(overflow.response.status, 409)
  assert.match(overflow.body.error, /All 10 local Hardhat accounts are assigned/)
})

test('assigns a legacy wallet mapping when it belongs to the live pool and is unused', async () => {
  const inserted = await app.locals.database.prepare(`
    INSERT INTO users (display_name, wallet_address, email, password_hash)
    VALUES (?, ?, ?, ?)
  `).run('Legacy profile', testAccounts[4], 'legacy@example.test', 'legacy-hash')
  const { users } = await app.locals.reconcileAccountAssignments()
  const legacy = users.find((user) => Number(user.id) === Number(inserted.lastInsertRowid))
  assert.equal(legacy.assignedAccount, testAccounts[4])
})

test('reports RPC unavailability and refuses stale account assignments', async () => {
  developmentAccountProvider = async () => { throw new Error('RPC offline') }
  const offlineRegistration = await request('/api/auth/register', {
    method: 'POST',
    cookie: '',
    body: JSON.stringify({
      displayName: 'Offline',
      email: 'offline@example.test',
      password: 'pw',
    }),
  })
  assert.equal(offlineRegistration.response.status, 503)
  assert.match(offlineRegistration.body.error, /RPC offline/)

  developmentAccountProvider = async () => testAccounts
  const user = await createUser('Pool user', 'pool-user@example.test')
  const oldCookie = user.cookie
  developmentAccountProvider = async () => testAccounts.map(
    (_, index) => `0x${(index + 101).toString(16).padStart(40, '0')}`,
  )
  await new Promise((resolve) => setTimeout(resolve, 1050))
  const me = await request('/api/auth/me', { cookie: oldCookie })
  assert.equal(me.response.status, 409)
  assert.match(me.body.error, /assignment was preserved and not replaced/)
})

test('creates and lists products with a valid seller foreign key', async () => {
  const seller = await createUser()
  const created = await createProduct()
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.price, '6.25')
  assert.equal(created.body.data.status, 'ACTIVE')
  assert.equal(created.body.data.sellerId, seller.body.data.id)

  const list = await request('/api/products?status=ACTIVE')
  assert.equal(list.response.status, 200)
  assert.equal(list.body.data.length, 1)
  assert.equal(list.body.data[0].title, 'Handmade mug')

  const fetched = await request(`/api/products/${created.body.data.id}`)
  assert.equal(fetched.response.status, 200)
  assert.equal(fetched.body.data.description, 'A locally stored product listing.')

  const forgedSeller = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Forged owner',
      description: 'Client supplied identity is rejected.',
      price: '2',
      category: 'Other',
      sellerId: 999,
    }),
  })
  assert.equal(forgedSeller.response.status, 400)
})

test('persists detailed product descriptions, categories, and validated image references', async () => {
  await createUser()
  const created = await createProduct(undefined, {
    title: 'Desk organizer',
    description: 'Oak organizer with three compartments and a felt base.',
    category: 'Home & Living',
    imageReference: 'https://images.example.test/desk-organizer.jpg',
  })
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.title, 'Desk organizer')
  assert.equal(created.body.data.description, 'Oak organizer with three compartments and a felt base.')
  assert.equal(created.body.data.category, 'Home & Living')
  assert.equal(created.body.data.imageReference, 'https://images.example.test/desk-organizer.jpg')

  const unsafeImage = await createProduct(undefined, {
    imageReference: 'javascript:alert(1)',
  })
  assert.equal(unsafeImage.response.status, 400)
})

test('validates product fields and query filters', async () => {
  await createUser()
  const invalid = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Product',
      description: 'Description',
      price: '0',
      category: 'Other',
    }),
  })
  assert.equal(invalid.response.status, 400)

  const invalidPrecision = await request('/api/products', {
    method: 'POST',
    body: JSON.stringify({
      title: 'Product',
      description: 'Description',
      price: '1.1234567890123456789',
      category: 'Other',
    }),
  })
  assert.equal(invalidPrecision.response.status, 400)

  const invalidFilter = await request('/api/products?status=ONCHAIN')
  assert.equal(invalidFilter.response.status, 400)
  const malformed = await fetch(`${baseUrl}/api/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(malformed.status, 400)
})

test('updates, deactivates, and filters product metadata', async () => {
  await createUser()
  const created = await createProduct()
  const id = created.body.data.id
  const updated = await request(`/api/products/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Updated mug', price: '7.50' }),
  })
  assert.equal(updated.response.status, 200)
  assert.equal(updated.body.data.title, 'Updated mug')
  assert.equal(updated.body.data.price, '7.50')

  const deactivated = await request(`/api/products/${id}/deactivate`, { method: 'POST' })
  assert.equal(deactivated.response.status, 200)
  assert.equal(deactivated.body.data.status, 'INACTIVE')
  assert.equal((await request('/api/products?status=ACTIVE')).body.data.length, 0)
  assert.equal((await request('/api/products?status=INACTIVE')).body.data.length, 1)
  assert.equal((await request('/api/products/999')).response.status, 404)
})

test('maps metadata uniquely to a local marketplace listing without creating chain data', async () => {
  const seller = await createUser('Mapped seller')
  const deployment = {
    chainId: 31337,
    marketplaceAddress: `0x${'c'.repeat(40)}`,
    deploymentId: '1bdb4854-c6c1-4d14-9840-5befb41bf27e',
    listingId: 42,
  }
  const created = await createProduct(seller.body.data.id, deployment)
  assert.equal(created.response.status, 201)
  assert.equal(created.body.data.chainId, 31337)
  assert.equal(created.body.data.marketplaceAddress, deployment.marketplaceAddress)
  assert.equal(created.body.data.deploymentId, deployment.deploymentId)
  assert.equal(created.body.data.listingId, 42)

  const scoped = await request(
    `/api/products?chainId=31337&marketplaceAddress=${deployment.marketplaceAddress}&deploymentId=${deployment.deploymentId}`,
  )
  assert.equal(scoped.response.status, 200)
  assert.equal(scoped.body.data.length, 1)
  assert.equal(scoped.body.data[0].id, created.body.data.id)

  const duplicate = await createProduct(seller.body.data.id, deployment)
  assert.equal(duplicate.response.status, 409)
  const newDeployment = await createProduct(seller.body.data.id, {
    ...deployment,
    deploymentId: '2bdb4854-c6c1-4d14-9840-5befb41bf27e',
  })
  assert.equal(newDeployment.response.status, 201)
  const unscoped = await request(
    `/api/products?chainId=31337&marketplaceAddress=${deployment.marketplaceAddress}`,
  )
  assert.equal(unscoped.response.status, 400)
  const partialLink = await createProduct(seller.body.data.id, { listingId: 43 })
  assert.equal(partialLink.response.status, 400)
  const nonLocal = await createProduct(seller.body.data.id, { ...deployment, chainId: 1 })
  assert.equal(nonLocal.response.status, 400)
})

test('serves public product listings but scopes Seller Studio records to their backend owner', async () => {
  const first = await createUser('First seller', 'first-seller@example.test')
  const firstProduct = await createProduct(undefined, {
    title: 'First owner listing',
    chainId: 31337,
    marketplaceAddress: `0x${'c'.repeat(40)}`,
    deploymentId: '1bdb4854-c6c1-4d14-9840-5befb41bf27e',
    listingId: 1,
  })
  assert.equal(firstProduct.response.status, 201)
  assert.equal(firstProduct.body.data.sellerId, first.body.data.id)

  const second = await createUser('Second seller', 'second-seller@example.test')
  listingSellerProvider = async () => second.body.data.assignedAccount
  const secondProduct = await createProduct(undefined, {
    title: 'Second owner listing',
    chainId: 31337,
    marketplaceAddress: `0x${'c'.repeat(40)}`,
    deploymentId: '1bdb4854-c6c1-4d14-9840-5befb41bf27e',
    listingId: 2,
  })
  assert.equal(secondProduct.response.status, 201)
  assert.equal(secondProduct.body.data.sellerId, second.body.data.id)

  const publicListings = await request('/api/products', { cookie: '' })
  assert.equal(publicListings.response.status, 200)
  assert.equal(publicListings.body.data.length, 2)

  const firstOwned = await request('/api/products/mine', { cookie: first.cookie })
  const secondOwned = await request('/api/products/mine', { cookie: second.cookie })
  assert.deepEqual(firstOwned.body.data.map((product) => product.title), ['First owner listing'])
  assert.deepEqual(secondOwned.body.data.map((product) => product.title), ['Second owner listing'])

  const crossOwnerUpdate = await request(`/api/products/${firstProduct.body.data.id}`, {
    method: 'PATCH',
    cookie: second.cookie,
    body: JSON.stringify({ title: 'Attempted takeover' }),
  })
  assert.equal(crossOwnerUpdate.response.status, 403)
})

test('rejects attaching metadata to another assigned account’s on-chain listing', async () => {
  const owner = await createUser('Chain owner', 'chain-owner@example.test')
  listingSellerProvider = async () => testAccounts[1]
  const mismatch = await createProduct(undefined, {
    title: 'Forged chain owner',
    chainId: 31337,
    marketplaceAddress: `0x${'c'.repeat(40)}`,
    deploymentId: '1bdb4854-c6c1-4d14-9840-5befb41bf27e',
    listingId: 8,
  })
  assert.equal(mismatch.response.status, 403)
  assert.match(mismatch.body.error, /assigned blockchain account/)
  assert.equal(owner.body.data.assignedAccount, testAccounts[0])
})

test('persists profiles and product records after backend restart', async () => {
  const seller = await createUser('Persistent seller')
  const assignedAccount = seller.body.data.assignedAccount
  const product = await createProduct(seller.body.data.id, { title: 'Survives restart' })
  const productId = product.body.data.id
  await stopApp()
  await startApp()

  const savedUser = await request(`/api/users/${seller.body.data.id}`)
  const savedProduct = await request(`/api/products/${productId}`)
  const authenticatedUser = await request('/api/auth/me')
  assert.equal(savedUser.body.data.displayName, 'Persistent seller')
  assert.equal(savedProduct.body.data.title, 'Survives restart')
  assert.equal(authenticatedUser.body.data.assignedAccount, assignedAccount)
})

test('requires authentication and enforces product ownership for writes', async () => {
  await createUser('Owner', 'owner@example.test')
  const product = await createProduct()
  const ownerCookie = activeSessionCookie

  const unauthenticatedCreate = await request('/api/products', {
    method: 'POST',
    cookie: '',
    body: JSON.stringify({
      title: 'No session',
      description: 'Must not be written.',
      price: '1',
      category: 'Other',
    }),
  })
  assert.equal(unauthenticatedCreate.response.status, 401)
  const unauthenticatedUpdate = await request(`/api/products/${product.body.data.id}`, {
    method: 'PATCH',
    cookie: '',
    body: JSON.stringify({ title: 'No session update' }),
  })
  assert.equal(unauthenticatedUpdate.response.status, 401)
  const unauthenticatedDeactivate = await request(`/api/products/${product.body.data.id}/deactivate`, {
    method: 'POST',
    cookie: '',
  })
  assert.equal(unauthenticatedDeactivate.response.status, 401)

  await createUser('Different owner', 'other@example.test')
  const otherCookie = activeSessionCookie
  const update = await request(`/api/products/${product.body.data.id}`, {
    method: 'PATCH',
    cookie: otherCookie,
    body: JSON.stringify({ title: 'Attempted takeover' }),
  })
  assert.equal(update.response.status, 403)
  const deactivate = await request(`/api/products/${product.body.data.id}/deactivate`, {
    method: 'POST',
    cookie: otherCookie,
  })
  assert.equal(deactivate.response.status, 403)

  const ownerUpdate = await request(`/api/products/${product.body.data.id}`, {
    method: 'PATCH',
    cookie: ownerCookie,
    body: JSON.stringify({ title: 'Owner update' }),
  })
  assert.equal(ownerUpdate.response.status, 200)
  assert.equal(ownerUpdate.body.data.title, 'Owner update')
})

test('rejects invalid and expired sessions while keeping product reads public', async () => {
  const owner = await createUser('Session owner', 'session-owner@example.test')
  const product = await createProduct()
  const ownerCookie = activeSessionCookie

  const publicList = await request('/api/products', { cookie: '' })
  assert.equal(publicList.response.status, 200)
  assert.equal(publicList.body.data.some((item) => item.id === product.body.data.id), true)

  const invalidSession = await request('/api/products', {
    method: 'POST',
    cookie: `crowzon_session=${'a'.repeat(64)}`,
    body: JSON.stringify({
      title: 'Invalid session listing',
      description: 'Must not be created.',
      price: '1',
      category: 'Other',
    }),
  })
  assert.equal(invalidSession.response.status, 401)

  app.locals.database.prepare('UPDATE sessions SET expires_at = 0 WHERE user_id = ?')
    .run(owner.body.data.id)
  const expiredSession = await request('/api/products', {
    method: 'POST',
    cookie: ownerCookie,
    body: JSON.stringify({
      title: 'Expired session listing',
      description: 'Must not be created.',
      price: '1',
      category: 'Other',
    }),
  })
  assert.equal(expiredSession.response.status, 401)
  assert.equal((await request('/api/products', { cookie: '' })).body.data.length, 1)
})

test('returns only indexed local-chain orders with explicit incomplete and unverified wallet state', async () => {
  const user = await createUser('History reader', 'history@example.test')
  const seller = user.body.data.assignedAccount
  const buyer = '0x4444444444444444444444444444444444444444'
  const association = await request('/api/auth/wallet', {
    method: 'PUT',
    body: JSON.stringify({ walletAddress: seller }),
  })
  assert.equal(association.response.status, 200)
  assert.equal(association.body.data.user.walletAddress, seller)
  assert.equal(association.body.data.user.assignedAccount, seller)
  assert.equal(association.body.data.walletAssociationVerified, false)
  const database = app.locals.database
  const deploymentId = '1bdb4854-c6c1-4d14-9840-5befb41bf27e'
  const insert = database.prepare(`
    INSERT INTO indexed_events (
      chain_id, deployment_id, contract_name, contract_address,
      transaction_hash, log_index, block_number, event_name, listing_id,
      transaction_id, buyer_address, seller_address, actor_address, args_json
    ) VALUES (?, ?, 'escrow', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  insert.run(
    31337, deploymentId, '0x2222222222222222222222222222222222222222',
    `0x${'1'.repeat(64)}`, 0, 10, 'PurchaseFunded', '42', '5',
    buyer, seller, buyer, JSON.stringify({ transactionId: '5', listingId: '42' }),
  )
  insert.run(
    31337, deploymentId, '0x2222222222222222222222222222222222222222',
    `0x${'2'.repeat(64)}`, 2, 15, 'PaymentReleased', null, '5',
    null, seller, seller, JSON.stringify({ transactionId: '5', amount: '625' }),
  )
  insert.run(
    31337, deploymentId, '0x2222222222222222222222222222222222222222',
    `0x${'3'.repeat(64)}`, 1, 16, 'DeliveryMarked', null, '6',
    null, seller, seller, JSON.stringify({ transactionId: '6' }),
  )
  database.prepare(`
    INSERT INTO indexer_cursors (
      chain_id, deployment_id, contract_address, contract_name, cursor_block
    ) VALUES (31337, ?, '0x2222222222222222222222222222222222222222', 'escrow', 16)
  `).run(deploymentId)

  const unauthenticated = await request(
    `/api/orders?chainId=31337&deploymentId=${deploymentId}`,
    { cookie: '' },
  )
  assert.equal(unauthenticated.response.status, 401)

  const orders = await request(
    `/api/orders?chainId=31337&deploymentId=${deploymentId}`,
  )
  assert.equal(orders.response.status, 200)
  assert.equal(orders.body.data.walletAssociationVerified, false)
  assert.equal(orders.body.data.orders.length, 2)
  const completed = orders.body.data.orders.find((order) => order.transactionId === '5')
  assert.equal(completed.complete, true)
  assert.equal(completed.status, null)
  assert.equal(completed.listingId, '42')
  assert.deepEqual(
    completed.events.map((event) => [event.name, event.blockNumber, event.logIndex]),
    [['PurchaseFunded', 10, 0], ['PaymentReleased', 15, 2]],
  )
  assert.equal(completed.events[0].transactionHash, `0x${'1'.repeat(64)}`)
  const incomplete = orders.body.data.orders.find((order) => order.transactionId === '6')
  assert.equal(incomplete.complete, false)
  assert.equal(incomplete.listingId, null)

  const forgedAddressQuery = await request(
    `/api/orders?walletAddress=${buyer}&chainId=31337&deploymentId=${deploymentId}`,
  )
  assert.equal(forgedAddressQuery.response.status, 400)

  await createUser('Unlinked profile', 'unlinked@example.test')
  const unlinkedHistory = await request(`/api/orders?chainId=31337&deploymentId=${deploymentId}`)
  assert.equal(unlinkedHistory.response.status, 200)
  assert.deepEqual(unlinkedHistory.body.data.orders, [])
})

test('prevents a development address from being associated with multiple profiles', async () => {
  const walletAddress = '0x6666666666666666666666666666666666666666'
  await createUser('First profile', 'first-wallet@example.test')
  const firstAssociation = await request('/api/auth/wallet', {
    method: 'PUT',
    body: JSON.stringify({ walletAddress }),
  })

  assert.equal(firstAssociation.response.status, 200)
  const firstCookie = firstAssociation.cookie

  await createUser('Second profile', 'second-wallet@example.test')
  const duplicateAssociation = await request('/api/auth/wallet', {
    method: 'PUT',
    body: JSON.stringify({ walletAddress }),
  })
  assert.equal(duplicateAssociation.response.status, 409)

  const secondProfile = await request('/api/auth/me')
  assert.equal(secondProfile.body.data.walletAddress, null)
  const firstProfile = await request('/api/auth/me', { cookie: firstCookie })
  assert.equal(firstProfile.body.data.walletAddress, walletAddress)
})

test('does not allow a user to associate another user’s assigned account', async () => {
  const first = await createUser('First assigned user', 'first-assigned@example.test')
  const second = await createUser('Second assigned user', 'second-assigned@example.test')
  const attempt = await request('/api/auth/wallet', {
    method: 'PUT',
    cookie: second.cookie,
    body: JSON.stringify({ walletAddress: first.body.data.assignedAccount }),
  })
  assert.equal(attempt.response.status, 403)
  assert.match(attempt.body.error, /another user’s assigned local blockchain account/)
  const current = await request('/api/auth/me', { cookie: second.cookie })
  assert.equal(current.body.data.assignedAccount, second.body.data.assignedAccount)
})

test('expires sessions and revokes them on logout', async () => {
  await stopApp()
  app = createApp({
    databasePath,
    sessionTtlMs: 30,
    getDevelopmentAccounts: developmentAccountProvider,
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
  const registered = await createUser('Expiring user', 'expiry@example.test')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const expired = await request('/api/auth/me', { cookie: registered.cookie })
  assert.equal(expired.response.status, 401)
})

test('returns structured not-found and rejects update of absent product', async () => {
  await createUser()
  const response = await request('/api/no-such-route')
  assert.equal(response.response.status, 404)
  assert.equal(response.body.error, 'Route not found.')
  const update = await request('/api/products/999', {
    method: 'PATCH',
    body: JSON.stringify({ title: 'Missing' }),
  })
  assert.equal(update.response.status, 404)
})
