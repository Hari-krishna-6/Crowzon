import assert from 'node:assert/strict'
import test from 'node:test'
import {
  apiRequest,
  associateWallet,
  attachListingMetadata,
  BackendApiError,
  createProduct,
  getCurrentUser,
  listProducts,
  listOrders,
  listUsers,
  login,
  logout,
  register,
} from '../src/api.js'

function response(data, { status = 200, ok = true } = {}) {
  return { ok, status, json: async () => data }
}

test('loads product metadata scoped to the local marketplace deployment', async () => {
  let requestedUrl
  const products = [{ id: 4, listingId: 8, chainId: 31337 }]
  const data = await listProducts({
    chainId: 31337,
    marketplaceAddress: '0xAbCd',
    deploymentId: '1bdb4854-c6c1-4d14-9840-5befb41bf27e',
    fetchImpl: async (url) => {
      requestedUrl = url
      return response({ data: products })
    },
  })

  assert.deepEqual(data, products)
  assert.equal(
    requestedUrl,
    '/api/products?chainId=31337&marketplaceAddress=0xAbCd&deploymentId=1bdb4854-c6c1-4d14-9840-5befb41bf27e',
  )
})

test('loads a profile using an encoded wallet query', async () => {
  let requestedUrl
  await listUsers({
    walletAddress: '0x1234',
    fetchImpl: async (url) => {
      requestedUrl = url
      return response({ data: [] })
    },
  })
  assert.equal(requestedUrl, '/api/users?walletAddress=0x1234')
})

test('loads authenticated order history scoped to the profile association and deployment', async () => {
  let requestedUrl
  const data = { walletAssociationVerified: false, orders: [], indexer: { available: true } }
  const result = await listOrders({
    chainId: 31337,
    deploymentId: '1bdb4854-c6c1-4d14-9840-5befb41bf27e',
    fetchImpl: async (url, options) => {
      requestedUrl = url
      assert.equal(options.credentials, 'same-origin')
      return response({ data })
    },
  })
  assert.deepEqual(result, data)
  assert.equal(
    requestedUrl,
    '/api/orders?chainId=31337&deploymentId=1bdb4854-c6c1-4d14-9840-5befb41bf27e',
  )
})

test('associates a wallet explicitly and indicates that ownership is unverified', async () => {
  let requestOptions
  const expected = {
    user: { id: 7, walletAddress: '0x1234' },
    walletAssociationVerified: false,
  }
  const result = await associateWallet('0x1234', {
    fetchImpl: async (url, options) => {
      assert.equal(url, '/api/auth/wallet')
      requestOptions = options
      return response({ data: expected })
    },
  })
  assert.deepEqual(result, expected)
  assert.equal(requestOptions.method, 'PUT')
  assert.deepEqual(JSON.parse(requestOptions.body), { walletAddress: '0x1234' })
})

test('keeps chain listings without metadata and scopes metadata to the deployment', () => {
  const listings = [
    { id: 3n, seller: '0xAa', description: 'On-chain title' },
    { id: 4n, seller: '0xBb', description: 'Listing without metadata' },
  ]
  const metadata = [
    {
      id: 9,
      sellerId: 1,
      listingId: 3,
      chainId: 31337,
      marketplaceAddress: '0xmarket',
      deploymentId: 'deployment-a',
      category: 'Digital',
      title: 'Persistent title',
    },
    {
      id: 10,
      listingId: 3,
      chainId: 31337,
      marketplaceAddress: '0xother',
      deploymentId: 'deployment-a',
      category: 'Wrong deployment',
    },
    {
      id: 11,
      listingId: 3,
      chainId: 31337,
      marketplaceAddress: '0xmarket',
      deploymentId: 'deployment-b',
      category: 'Wrong deployment instance',
    },
  ]
  const merged = attachListingMetadata(
    listings,
    metadata,
    [{ id: 1, assignedAccount: listings[0].seller, walletAddress: '0xaa', displayName: 'Alice' }],
    { chainId: 31337n, marketplaceAddress: '0xMarket', deploymentId: 'deployment-a' },
  )

  assert.equal(merged.length, 2)
  assert.equal(merged[0].metadata.title, 'Persistent title')
  assert.equal(merged[0].sellerProfile.displayName, 'Alice')
  assert.equal(merged[1].metadata, null)
})

test('does not attribute a legacy listing to a profile whose assigned account differs from its chain seller', () => {
  const listings = [{ id: 1n, seller: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }]
  const products = [{
    id: 12,
    sellerId: 2,
    listingId: 1,
    chainId: 31337,
    marketplaceAddress: '0xMarket',
    deploymentId: 'deployment-a',
  }]
  const [listing] = attachListingMetadata(
    listings,
    products,
    [{ id: 2, assignedAccount: '0xcccccccccccccccccccccccccccccccccccccccc', displayName: 'Metadata owner' }],
    { chainId: 31337, marketplaceAddress: '0xMarket', deploymentId: 'deployment-a' },
  )

  assert.equal(listing.metadata.sellerId, 2)
  assert.equal(listing.sellerProfile, null)
})

test('creates product metadata without creating a blockchain transaction', async () => {
  let requestOptions
  const record = { id: 1, listingId: 2 }
  const result = await createProduct(
    { title: 'A title', listingId: 2 },
    {
      fetchImpl: async (_url, options) => {
        requestOptions = options
        return response({ data: record }, { status: 201 })
      },
    },
  )
  assert.deepEqual(result, record)
  assert.equal(requestOptions.method, 'POST')
  assert.deepEqual(JSON.parse(requestOptions.body), { title: 'A title', listingId: 2 })
})

test('uses same-origin session requests for registration, login, identity, and logout', async () => {
  const requests = []
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options })
    return response({ data: { id: 7, displayName: 'Demo User' } })
  }

  await register(
    { displayName: 'Demo User', email: 'demo@example.test', password: 'correct horse battery staple' },
    { fetchImpl },
  )
  await login({ email: 'demo@example.test', password: 'correct horse battery staple' }, { fetchImpl })
  await getCurrentUser({ fetchImpl })
  await logout({ fetchImpl })

  assert.deepEqual(requests.map(({ url }) => url), [
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/me',
    '/api/auth/logout',
  ])
  assert.ok(requests.every(({ options }) => options.credentials === 'same-origin'))
  assert.equal(requests[0].options.method, 'POST')
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    displayName: 'Demo User',
    email: 'demo@example.test',
    password: 'correct horse battery staple',
  })
})

test('surfaces API validation and backend availability errors', async () => {
  await assert.rejects(
    apiRequest('/api/products', {
      fetchImpl: async () => response({ error: 'sellerId is required.' }, { status: 400, ok: false }),
    }),
    (error) => error instanceof BackendApiError && error.status === 400 && error.message === 'sellerId is required.',
  )
  await assert.rejects(
    apiRequest('/api/products', { fetchImpl: async () => { throw new Error('offline') } }),
    (error) => error instanceof BackendApiError && error.message.includes('offline'),
  )
})
