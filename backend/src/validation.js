export class ApiError extends Error {
  constructor(status, message, details) {
    super(message)
    this.status = status
    this.details = details
  }
}

const WALLET_PATTERN = /^0x[a-fA-F0-9]{40}$/
const PRICE_PATTERN = /^\d+(?:\.\d{1,18})?$/
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'Request body must be a JSON object.')
  }
}

function rejectUnknownFields(body, allowed) {
  const unknown = Object.keys(body).filter((field) => !allowed.includes(field))
  if (unknown.length) throw new ApiError(400, `Unknown field: ${unknown.join(', ')}.`)
}

function requiredText(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > maximum) {
    throw new ApiError(400, `${field} must be a non-empty string of at most ${maximum} characters.`)
  }
  return value.trim()
}

export function validateUser(body) {
  requireObject(body)
  rejectUnknownFields(body, ['displayName', 'walletAddress'])
  const displayName = requiredText(body.displayName, 'displayName', 80)
  let walletAddress = null
  if (body.walletAddress !== undefined && body.walletAddress !== null && body.walletAddress !== '') {
    if (typeof body.walletAddress !== 'string' || !WALLET_PATTERN.test(body.walletAddress)) {
      throw new ApiError(400, 'walletAddress must be a 20-byte 0x-prefixed address.')
    }
    walletAddress = body.walletAddress.toLowerCase()
  }
  return { displayName, walletAddress }
}

export function validateRegistration(body) {
  requireObject(body)
  rejectUnknownFields(body, ['displayName', 'email', 'password'])
  const displayName = requiredText(body.displayName, 'displayName', 80)
  if (typeof body.email !== 'string' || body.email.length > 254) {
    throw new ApiError(400, 'email must be a valid email address of at most 254 characters.')
  }
  const email = body.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError(400, 'email must be a valid email address.')
  }
  if (typeof body.password !== 'string' || body.password.length < 1 || body.password.length > 128) {
    throw new ApiError(400, 'password must be between 1 and 128 characters.')
  }
  return { displayName, email, password: body.password }
}

export function validateLogin(body) {
  requireObject(body)
  rejectUnknownFields(body, ['email', 'password'])
  if (typeof body.email !== 'string' || body.email.length > 254) {
    throw new ApiError(400, 'email and password are required.')
  }
  const email = body.email.trim().toLowerCase()
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    typeof body.password !== 'string' ||
    body.password.length < 1 ||
    body.password.length > 128
  ) {
    throw new ApiError(400, 'A valid email and password are required.')
  }
  return { email, password: body.password }
}

export function validateWalletAssociation(body) {
  requireObject(body)
  rejectUnknownFields(body, ['walletAddress'])
  if (typeof body.walletAddress !== 'string' || !WALLET_PATTERN.test(body.walletAddress)) {
    throw new ApiError(400, 'walletAddress must be a 20-byte 0x-prefixed local development address.')
  }
  return { walletAddress: body.walletAddress.toLowerCase() }
}

export function validateProduct(body, { partial = false } = {}) {
  requireObject(body)
  const fields = [
    'title',
    'description',
    'price',
    'category',
    'imageReference',
    'status',
    'chainId',
    'marketplaceAddress',
    'deploymentId',
    'listingId',
  ]
  rejectUnknownFields(body, partial ? fields : fields.filter((field) => field !== 'status'))
  if (partial && Object.keys(body).length === 0) throw new ApiError(400, 'Provide at least one product field to update.')

  const result = {}
  const sourceFields = partial
    ? Object.keys(body)
    : [
        'title',
        'description',
        'price',
        'category',
        'imageReference',
        ...['chainId', 'marketplaceAddress', 'deploymentId', 'listingId'].filter((field) => body[field] !== undefined),
      ]
  for (const field of sourceFields) {
    if (body[field] === undefined) {
      if (partial) continue
      throw new ApiError(400, `${field} is required.`)
    }
    switch (field) {
      case 'title':
        result.title = requiredText(body.title, 'title', 120)
        break
      case 'description':
        result.description = requiredText(body.description, 'description', 2000)
        break
      case 'price': {
        const price = typeof body.price === 'number' && Number.isFinite(body.price)
          ? String(body.price)
          : body.price
        if (typeof price !== 'string' || !PRICE_PATTERN.test(price) || !/[1-9]/.test(price)) {
          throw new ApiError(400, 'price must be a positive decimal CVT amount with at most 18 fractional digits.')
        }
        result.price = price
        break
      }
      case 'category':
        result.category = requiredText(body.category, 'category', 64)
        break
      case 'imageReference':
        if (body.imageReference === null || body.imageReference === '') result.imageReference = null
        else {
          const imageReference = requiredText(body.imageReference, 'imageReference', 2048)
          if (
            !imageReference.startsWith('/') ||
            imageReference.startsWith('//')
          ) {
            let parsed
            try {
              parsed = new URL(imageReference)
            } catch {
              throw new ApiError(400, 'imageReference must be a relative path or an HTTP(S) URL.')
            }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              throw new ApiError(400, 'imageReference must be a relative path or an HTTP(S) URL.')
            }
          }
          result.imageReference = imageReference
        }
        break
      case 'status':
        if (!['ACTIVE', 'INACTIVE'].includes(body.status)) {
          throw new ApiError(400, 'status must be ACTIVE or INACTIVE.')
        }
        result.status = body.status
        break
      case 'chainId': {
        const chainId = Number(body.chainId)
        if (chainId !== 31337) throw new ApiError(400, 'Only local Hardhat chain ID 31337 is supported.')
        result.chainId = chainId
        break
      }
      case 'marketplaceAddress':
        if (typeof body.marketplaceAddress !== 'string' || !ADDRESS_PATTERN.test(body.marketplaceAddress)) {
          throw new ApiError(400, 'marketplaceAddress must be a 20-byte 0x-prefixed address.')
        }
        result.marketplaceAddress = body.marketplaceAddress.toLowerCase()
        break
      case 'listingId': {
        const listingId = Number(body.listingId)
        if (!Number.isSafeInteger(listingId) || listingId < 1) {
          throw new ApiError(400, 'listingId must be a positive integer.')
        }
        result.listingId = listingId
        break
      }
      case 'deploymentId':
        if (typeof body.deploymentId !== 'string' || !DEPLOYMENT_ID_PATTERN.test(body.deploymentId)) {
          throw new ApiError(400, 'deploymentId must be a UUID from the local deployment artifact.')
        }
        result.deploymentId = body.deploymentId.toLowerCase()
        break
      default:
        throw new ApiError(400, `Unsupported field: ${field}.`)
    }
  }

  const mappingFields = ['chainId', 'marketplaceAddress', 'deploymentId', 'listingId']
  const mappingCount = mappingFields.filter((field) => result[field] !== undefined).length
  if (!partial && mappingCount !== 0 && mappingCount !== mappingFields.length) {
    throw new ApiError(400, 'chainId, marketplaceAddress, deploymentId, and listingId must be provided together.')
  }
  if (partial && mappingCount > 0) {
    throw new ApiError(400, 'On-chain listing references cannot be changed after creation.')
  }
  return result
}

export function parseId(value, field = 'id') {
  if (!/^[1-9]\d*$/.test(value)) throw new ApiError(400, `${field} must be a positive integer.`)
  const id = Number(value)
  if (!Number.isSafeInteger(id)) throw new ApiError(400, `${field} is outside the supported range.`)
  return id
}
