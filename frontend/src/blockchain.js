import { Contract, JsonRpcProvider, formatEther, parseEther } from 'ethers'
import {
  deployment,
  escrowAbi,
  marketplaceAbi,
} from 'virtual:crowzon-contracts'

export const EXPECTED_CHAIN_ID = 31337n
export const NATIVE_CURRENCY_SYMBOL = 'ETH'
export const NATIVE_CURRENCY_DECIMALS = 18
export const STATUS = Object.freeze({
  0: 'Funded',
  1: 'Delivered',
  2: 'Disputed',
  3: 'Completed',
  4: 'Refunded',
})
export const REFUND_REASONS = Object.freeze({
  0: 'Buyer cancelled',
  1: 'Delivery deadline passed',
  2: 'Resolver decision',
  3: 'Dispute deadline passed',
})

let provider

export function getProvider() {
  if (!provider) {
    provider = new JsonRpcProvider(`${window.location.origin}/rpc`)
  }
  return provider
}

export async function getUnlockedLocalSigner(account) {
  const rpcProvider = getProvider()
  const [chain, accounts] = await Promise.all([
    rpcProvider.getNetwork(),
    rpcProvider.send('eth_accounts', []),
  ])

  if (chain.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong local network: expected chain ID ${EXPECTED_CHAIN_ID}, received ${chain.chainId}.`,
    )
  }

  const normalizedAccount = account?.toLowerCase()
  if (!normalizedAccount) {
    throw new Error('Select a local development account before submitting a transaction.')
  }

  if (!accounts.some((item) => item.toLowerCase() === normalizedAccount)) {
    throw new Error(
      `Account ${shortAddress(account)} is not unlocked on the local Hardhat node. Please select one of the unlocked development accounts.`,
    )
  }

  return rpcProvider.getSigner(account)
}

export async function connectLocalChain() {
  const rpcProvider = getProvider()
  const [chain, accounts] = await Promise.all([
    rpcProvider.getNetwork(),
    rpcProvider.send('eth_accounts', []),
  ])

  if (chain.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(
      `Wrong local network: expected chain ID ${EXPECTED_CHAIN_ID}, received ${chain.chainId}.`,
    )
  }
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('The local node returned no unlocked development accounts.')
  }

  const contractCode = await Promise.all([
    rpcProvider.getCode(deployment.marketplace),
    rpcProvider.getCode(deployment.escrow),
  ])
  if (contractCode.some((code) => code === '0x')) {
    throw new Error(
      'The native-ETH Crowzon deployment artifact is configured, but its contracts are not deployed on the running local node.',
    )
  }

  return {
    provider: rpcProvider,
    accounts,
    chainId: chain.chainId,
  }
}

export function getContracts(signerOrProvider) {
  return {
    marketplace: new Contract(
      deployment.marketplace,
      marketplaceAbi,
      signerOrProvider,
    ),
    escrow: new Contract(deployment.escrow, escrowAbi, signerOrProvider),
  }
}

export function formatEth(value, maximumFractionDigits = 2) {
  const formatted = formatEther(value)
  const [whole, fraction = ''] = formatted.split('.')
  const visibleFraction = fraction
    .slice(0, maximumFractionDigits)
    .replace(/0+$/, '')
  return visibleFraction ? `${whole}.${visibleFraction}` : whole
}

export function parseEthAmount(value) {
  return parseEther(value)
}

export function shortAddress(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function describeError(error) {
  const shortMessage =
    error?.shortMessage ||
    error?.reason ||
    error?.info?.error?.message ||
    error?.message ||
    'The blockchain operation failed.'
  return shortMessage
    .replace(/^execution reverted:?\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .split('\n')[0]
}

const listingPresentationCache = new Map()

export function getListingPresentation(listingId, description) {
  const key = listingId.toString()
  const cached = listingPresentationCache.get(key)
  if (cached?.description === description) return cached.presentation

  const normalized = description.toLowerCase()
  let presentation
  if (/\b(design|logo|website|code|digital|template)\b/.test(normalized)) {
    presentation = { category: 'Digital', icon: '◇', tone: 'lavender' }
  } else if (/\b(tutor\w*|lesson\w*|service\w*|repair\w*|consult\w*|help\w*)\b/.test(normalized)) {
    presentation = { category: 'Services', icon: '✳', tone: 'mint' }
  } else if (/\b(mug|home|ceramic|furniture|lamp|handmade)\b/.test(normalized)) {
    presentation = { category: 'Home & Living', icon: '⌂', tone: 'peach' }
  } else {
    presentation = {
      category: `Listing #${key}`,
      icon: '✦',
      tone: 'blue',
    }
  }
  listingPresentationCache.set(key, { description, presentation })
  return presentation
}
