export class BackendApiError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.name = 'BackendApiError'
    this.status = status
  }
}

export async function apiRequest(path, { fetchImpl = fetch, ...options } = {}) {
  let response
  try {
    response = await fetchImpl(path, {
      ...options,
      credentials: options.credentials ?? 'same-origin',
      headers: {
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
    })
  } catch (error) {
    throw new BackendApiError(`Metadata API unavailable: ${error.message || 'connection failed'}`)
  }

  let body
  try {
    body = await response.json()
  } catch {
    throw new BackendApiError('Metadata API returned an invalid response.', response.status)
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== '/api/auth/login' &&
      path !== '/api/auth/me' &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new CustomEvent('crowzon:session-expired'))
    }
    throw new BackendApiError(body?.error || `Metadata API request failed (${response.status}).`, response.status)
  }
  if (!Array.isArray(body?.data) && !body?.data) {
    throw new BackendApiError('Metadata API response did not include data.', response.status)
  }
  return body.data
}

export function listProducts({ chainId, marketplaceAddress, deploymentId, fetchImpl } = {}) {
  const params = new URLSearchParams()
  if (chainId !== undefined) params.set('chainId', String(chainId))
  if (marketplaceAddress) params.set('marketplaceAddress', marketplaceAddress)
  if (deploymentId) params.set('deploymentId', deploymentId)
  const query = params.size ? `?${params.toString()}` : ''
  return apiRequest(`/api/products${query}`, { fetchImpl })
}

export function listMyProducts(options = {}) {
  return apiRequest('/api/products/mine', options)
}

export function listUsers({ walletAddress, fetchImpl } = {}) {
  const query = walletAddress
    ? `?${new URLSearchParams({ walletAddress }).toString()}`
    : ''
  return apiRequest(`/api/users${query}`, { fetchImpl })
}

export function listOrders({ chainId, deploymentId, fetchImpl } = {}) {
  const params = new URLSearchParams()
  if (chainId !== undefined) params.set('chainId', String(chainId))
  if (deploymentId) params.set('deploymentId', deploymentId)
  return apiRequest(`/api/orders?${params.toString()}`, { fetchImpl })
}

export function associateWallet(walletAddress, options = {}) {
  return apiRequest('/api/auth/wallet', {
    ...options,
    method: 'PUT',
    body: JSON.stringify({ walletAddress }),
  })
}

export function register(credentials, options = {}) {
  return apiRequest('/api/auth/register', {
    ...options,
    method: 'POST',
    body: JSON.stringify(credentials),
  })
}

export function login(credentials, options = {}) {
  return apiRequest('/api/auth/login', {
    ...options,
    method: 'POST',
    body: JSON.stringify(credentials),
  })
}

export function logout(options = {}) {
  return apiRequest('/api/auth/logout', {
    ...options,
    method: 'POST',
  })
}

export function getCurrentUser(options = {}) {
  return apiRequest('/api/auth/me', options)
}

export function createProduct(product, options = {}) {
  return apiRequest('/api/products', {
    ...options,
    method: 'POST',
    body: JSON.stringify(product),
  })
}

export function updateProduct(id, changes, options = {}) {
  return apiRequest(`/api/products/${encodeURIComponent(id)}`, {
    ...options,
    method: 'PATCH',
    body: JSON.stringify(changes),
  })
}

export function attachListingMetadata(listings, products, users, deployment) {
  const profilesById = new Map(users.map((profile) => [Number(profile.id), profile]))
  const productsByListingId = new Map(
    products
      .filter((product) =>
        Number(product.chainId) === Number(deployment.chainId) &&
        product.marketplaceAddress?.toLowerCase() === deployment.marketplaceAddress.toLowerCase() &&
        product.deploymentId === deployment.deploymentId &&
        product.listingId !== null &&
        product.listingId !== undefined,
      )
      .map((product) => [String(product.listingId), product]),
  )

  return listings.map((listing) => {
    const metadata = productsByListingId.get(listing.id.toString()) ?? null
    const metadataOwner = metadata ? profilesById.get(Number(metadata.sellerId)) : null
    const sellerProfile = metadataOwner?.assignedAccount?.toLowerCase() === listing.seller.toLowerCase()
      ? metadataOwner
      : null
    return { ...listing, metadata, sellerProfile }
  })
}
