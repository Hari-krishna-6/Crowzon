import { useCallback, useEffect, useMemo, useState } from 'react'
import { deployment } from 'virtual:crowzon-contracts'
import {
  attachListingMetadata,
  createProduct as createProductMetadata,
  getCurrentUser,
  listProducts,
  listMyProducts,
  listOrders,
  listUsers,
  login as loginUser,
  logout as logoutUser,
  register as registerUser,
  updateProduct as updateProductMetadata,
} from './api'
import {
  connectLocalChain,
  describeError,
  formatEth,
  getContracts,
  getListingPresentation,
  getProvider,
  getUnlockedLocalSigner,
  parseEthAmount,
  REFUND_REASONS,
  shortAddress,
  STATUS,
} from './blockchain'
import { summarizeEscrowVault } from './escrow-vault'
import {
  getSellerStudioListings,
  ownsListingMetadata,
} from './seller-ownership'
import {
  AuthenticationRequiredError,
  getAssignedBlockchainAccount,
  withAuthenticatedSession,
} from './auth-guard'
import './App.css'

const HISTORY_LIMIT = 100
const LISTING_LIMIT = 100
const ACTIVE_STATES = new Set([0, 1, 2])
const CATEGORIES = ['All items', 'Home & Living', 'Digital', 'Services']
const LISTING_CATEGORIES = CATEGORIES.filter((item) => item !== 'All items')

function Icon({ name, size = 20 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }

  const paths = {
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    bag: <><path d="M5 8.5h14l1.2 12H3.8L5 8.5Z" /><path d="M9 9V6a3 3 0 0 1 6 0v3" /></>,
    grid: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.5" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.5" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.5" /></>,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.3 2" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4.7 9a7.8 7.8 0 0 1 13-2L20 9M4 17v-5h5" /><path d="M19.3 15a7.8 7.8 0 0 1-13 2L4 15" /></>,
    plus: <><path d="M12 5v14M5 12h14" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    shield: <><path d="M12 3 20 6v5.5c0 4.6-3.3 7.8-8 9.5-4.7-1.7-8-4.9-8-9.5V6l8-3Z" /><path d="m9 12 2 2 4-4" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    tag: <><path d="M20 13 13 20l-9-9V4h7l9 9Z" /><circle cx="8.5" cy="8.5" r="1" /></>,
    wallet: <><rect x="3" y="5" width="18" height="15" rx="2.5" /><path d="M3 9h18M16 14h2" /><path d="M6 5V3h12v2" /></>,
    lock: <><rect x="4.5" y="10" width="15" height="11" rx="2" /><path d="M8 10V7a4 4 0 1 1 8 0v3M12 14v3" /></>,
    menu: <><path d="M4 6h16M4 12h16M4 18h16" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" /></>,
    edit: <><path d="m14 5 5 5M4 20l4-.8L19 8a2.1 2.1 0 0 0-3-3L5 16l-1 4Z" /></>,
    box: <><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z" /><path d="m3.5 8 8.5 5 8.5-5M12 13v8" /></>,
  }

  return <svg {...common}>{paths[name] ?? paths.tag}</svg>
}

function Logo({ compact = false }) {
  return (
    <a className={`brand ${compact ? 'brand-compact' : ''}`} href="#home" aria-label="Crowzon home">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 36 36" fill="none">
          <path d="M18 3.5 32.5 12v12L18 32.5 3.5 24V12L18 3.5Z" stroke="currentColor" strokeWidth="2.2" />
          <path d="M12 14.2a7.4 7.4 0 1 1 0 7.6M12 18h12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="brand-word">crowzon<span className="brand-period">.</span></span>
    </a>
  )
}

function formatDate(timestamp) {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(Number(timestamp) * 1000))
}

function parseOnChainError(error) {
  const message = describeError(error)
  const errorMap = [
    ['InvalidAmount', 'The selected account does not have enough ETH to complete this purchase.'],
    ['insufficient funds', 'This development account does not have enough ETH to cover the purchase and gas.'],
    ['SelfPurchase', 'You cannot purchase your own listing. Select a different local account.'],
    ['ListingInactive', 'This listing is no longer active. Refresh the marketplace.'],
    ['Unauthorized', 'The selected account is not allowed to perform this action.'],
    ['DeliveryWindowExpired', 'The seller delivery window has expired. The buyer may request a refund.'],
    ['DeliveryWindowNotExpired', 'The delivery timeout has not elapsed yet.'],
    ['ReviewPeriodNotExpired', 'The buyer review period is still open.'],
    ['DisputeResolutionPeriodNotExpired', 'The dispute resolution period is still open.'],
    ['InvalidState', 'This action is not available in the transaction’s current state.'],
  ]
  const matched = errorMap.find(([code]) => message.includes(code))
  return matched ? matched[1] : message
}

function ListingCard({ listing, sellerProfile, canManage, isOwnBlockchainAccount, onBuy, onEdit, isBusy }) {
  const presentation = getListingPresentation(listing.id, listing.description)
  const category = listing.metadata?.category
  const listingPresentation = category
    ? {
        ...presentation,
        category,
        tone: category === 'Digital' ? 'lavender' : category === 'Services' ? 'mint' : 'peach',
      }
    : presentation
  return (
    <article className="listing-card">
      <div className={`listing-art tone-${listingPresentation.tone}`}>
        {listing.metadata?.imageReference ? (
          <img
            className="listing-photo"
            src={listing.metadata.imageReference}
            alt=""
            loading="lazy"
            onError={(event) => { event.currentTarget.hidden = true }}
          />
        ) : null}
        <span className="listing-art-glyph" aria-hidden="true">{listingPresentation.icon}</span>
        <span className="art-note">Crowzon marketplace</span>
        <span className="art-id">ITEM {String(listing.id).padStart(3, '0')}</span>
      </div>
      <div className="listing-info">
        <div className="listing-category-row">
          <span className="category-label">{listingPresentation.category}</span>
          <span className={`availability ${listing.active ? 'is-active' : 'is-inactive'}`}>
            <span />{listing.active ? 'Available' : 'Inactive'}
          </span>
        </div>
        <h3>{listing.metadata?.title || listing.description}</h3>
        {listing.metadata?.description && listing.metadata.description !== (listing.metadata?.title || listing.description) ? (
          <p className="listing-description">{listing.metadata.description}</p>
        ) : null}
        <div className="seller-line">
          <span className="seller-avatar">{listing.seller.slice(2, 4).toUpperCase()}</span>
          <span>{sellerProfile?.displayName || 'Seller'} <strong>{shortAddress(listing.seller)}</strong></span>
        </div>
        <div className="listing-footer">
          <div className="price-block">
            <strong>{formatEth(listing.price)} <span>ETH</span></strong>
            <small>Native ETH price</small>
          </div>
          {canManage ? (
            <button className="button button-outline button-small" type="button" onClick={() => onEdit(listing)}>
              <Icon name="edit" size={15} /> Manage
            </button>
          ) : isOwnBlockchainAccount ? (
            <button className="button button-outline button-small" type="button" disabled title="Backend ownership metadata does not match the on-chain seller.">
              Ownership review
            </button>
          ) : (
            <button
              className="button button-primary button-small"
              type="button"
              disabled={!listing.active || !account || isBusy}
              onClick={() => onBuy(listing)}
            >
              {isBusy ? 'Working…' : 'Purchase'} <Icon name="arrow" size={15} />
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

function StatCard({ icon, label, value, note, tone }) {
  return (
    <article className="stat-card">
      <span className={`stat-icon ${tone}`}><Icon name={icon} size={19} /></span>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-note">{note}</div>
    </article>
  )
}

function TransactionCard({ transaction, account, resolver, busyId, chainTimestamp, runAction }) {
  const isBuyer = account?.toLowerCase() === transaction.buyer.toLowerCase()
  const isSeller = account?.toLowerCase() === transaction.seller.toLowerCase()
  const isResolver = account?.toLowerCase() === resolver.toLowerCase()
  const actions = []
  const id = transaction.id
  const now = chainTimestamp
  const canDisputeFunded =
    transaction.status === 0 && now <= transaction.fundedAt + 7n * 24n * 60n * 60n
  const canDisputeDelivered =
    transaction.status === 1 && now <= transaction.deliveredAt + 7n * 24n * 60n * 60n
  if (
    transaction.status === 0 &&
    isSeller &&
    now <= transaction.fundedAt + 7n * 24n * 60n * 60n
  ) {
    actions.push({ label: 'Mark delivered', action: 'markDelivered', primary: true })
  }
  if (transaction.status === 0 && isBuyer) {
    actions.push({ label: 'Cancel purchase', action: 'cancelBeforeDelivery' })
  }
  if ((canDisputeFunded || canDisputeDelivered) && (isBuyer || isSeller)) {
    actions.push({ label: 'Raise dispute', action: 'raiseDispute' })
  }
  if (transaction.status === 1 && isBuyer) {
    actions.push({ label: 'Confirm delivery', action: 'confirmDelivery', primary: true })
  }
  if (transaction.status === 2 && isResolver) {
    actions.push({ label: 'Resolve: release', action: 'resolveRelease', primary: true })
    actions.push({ label: 'Resolve: refund', action: 'resolveRefund' })
  }
  if (
    transaction.status === 0 &&
    now >= transaction.fundedAt + 7n * 24n * 60n * 60n
  ) {
    actions.push({ label: 'Refund undelivered item', action: 'refundUndelivered' })
  }
  if (
    transaction.status === 2 &&
    now >= transaction.disputedAt + 30n * 24n * 60n * 60n
  ) {
    actions.push({ label: 'Refund unresolved dispute', action: 'refundUnresolvedDispute' })
  }
  if (
    transaction.status === 1 &&
    now >= transaction.deliveredAt + 7n * 24n * 60n * 60n
  ) {
    actions.push({ label: 'Finalize after review period', action: 'finalizeAfterReviewPeriod' })
  }

  return (
    <article className="transaction-card">
      <div className="transaction-icon"><Icon name={transaction.status === 3 ? 'shield' : 'box'} size={19} /></div>
      <div className="transaction-main">
        <div className="transaction-heading">
          <div>
            <span className="transaction-id">Transaction #{transaction.id}</span>
            <h3>{transaction.description || `Listing #${transaction.listingId}`}</h3>
          </div>
          <span className={`status-pill status-${STATUS[transaction.status]?.toLowerCase()}`}>
            {STATUS[transaction.status]}
          </span>
        </div>
        <div className="transaction-meta">
          <span>{isBuyer ? 'Buyer: You' : `Buyer: ${shortAddress(transaction.buyer)}`}</span>
          <span>{isSeller ? 'Seller: You' : `Seller: ${shortAddress(transaction.seller)}`}</span>
          <span>{formatDate(transaction.fundedAt)}</span>
          <strong>{formatEth(transaction.amount)} ETH</strong>
        </div>
        <div className="transaction-chain-details">
          <span>Current state from contract</span>
          <div className="event-trail">
            {transaction.events.map((event) => (
              <span key={`${event.name}-${event.transactionHash}`} title={event.transactionHash}>
                {event.name}{event.detail && ` · ${event.detail}`} <code>#{event.blockNumber}</code> <code>{shortAddress(event.transactionHash)}</code>
              </span>
            ))}
          </div>
        </div>
        {actions.length > 0 && (
          <div className="transaction-actions">
            {actions.map(({ label, action, primary }) => (
              <button
                className={`button ${primary ? 'button-primary' : 'button-soft'} button-small`}
                key={action}
                type="button"
                disabled={busyId === id}
                onClick={() => runAction(transaction, action)}
              >
                {busyId === id ? 'Waiting…' : label}
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  )
}

function App() {
  const [connection, setConnection] = useState({ status: 'connecting', error: '' })
  const [authUser, setAuthUser] = useState(null)
  const account = authUser?.assignedAccount ?? ''
  const [listings, setListings] = useState([])
  const [ownedProducts, setOwnedProducts] = useState([])
  const [ownedProductsStatus, setOwnedProductsStatus] = useState({ state: 'signed-out', message: '' })
  const [metadataStatus, setMetadataStatus] = useState({ state: 'loading', message: '' })
  const [transactions, setTransactions] = useState([])
  const [vaultTransactions, setVaultTransactions] = useState([])
  const [vaultBalance, setVaultBalance] = useState(0n)
  const [vaultRefreshedAt, setVaultRefreshedAt] = useState(null)
  const [vaultFilter, setVaultFilter] = useState('all')
  const [indexedOrderData, setIndexedOrderData] = useState(null)
  const [indexedOrderStatus, setIndexedOrderStatus] = useState({ state: 'signed-out', message: '' })
  const [balance, setBalance] = useState(0n)
  const [lockedBalance, setLockedBalance] = useState(0n)
  const [sellerProceeds, setSellerProceeds] = useState(0n)
  const [chainTimestamp, setChainTimestamp] = useState(0n)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All items')
  const [page, setPage] = useState('market')
  const [modal, setModal] = useState(null)
  const [authModalOpen, setAuthModalOpen] = useState(false)
  const [authMode, setAuthMode] = useState('login')
  const [authForm, setAuthForm] = useState({ displayName: '', email: '', password: '' })
  const [authError, setAuthError] = useState('')
  const [authBusy, setAuthBusy] = useState(false)
  const [editListing, setEditListing] = useState(null)
  const [newListing, setNewListing] = useState({
    description: '',
    details: '',
    price: '',
    category: LISTING_CATEGORIES[0],
    imageReference: '',
  })
  const [busy, setBusy] = useState('')
  const [busyId, setBusyId] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  const refresh = useCallback(async ({ preserveFeedback = false } = {}) => {
    try {
      const local = await connectLocalChain()

      const { marketplace, escrow } = getContracts(local.provider)
      const nextListingId = await marketplace.nextListingId()
      const startListing = nextListingId > BigInt(LISTING_LIMIT)
        ? nextListingId - BigInt(LISTING_LIMIT)
        : 1n
      const listingIds = []
      for (let id = startListing; id < nextListingId; id += 1n) listingIds.push(id)
      const listingRecords = await Promise.all(
        listingIds.map(async (id) => {
          try {
            const listing = await marketplace.getListing(id)
            return {
              id,
              seller: listing.seller,
              description: listing.description,
              price: listing.price,
              active: listing.active,
            }
          } catch (error) {
            if (error?.revert?.name === 'ListingNotFound') return null
            throw error
          }
        }),
      )
      const [metadataResult, profilesResult] = await Promise.allSettled([
        listProducts({
          chainId: Number(local.chainId),
          marketplaceAddress: deployment.marketplace,
          deploymentId: deployment.deploymentId,
        }),
        listUsers(),
      ])
      const productMetadata = metadataResult.status === 'fulfilled' ? metadataResult.value : []
      const profiles = profilesResult.status === 'fulfilled' ? profilesResult.value : []
      const listingsWithMetadata = attachListingMetadata(
        listingRecords.filter(Boolean),
        productMetadata,
        profiles,
        {
          chainId: local.chainId,
          marketplaceAddress: deployment.marketplace,
          deploymentId: deployment.deploymentId,
        },
      )
      setMetadataStatus(metadataResult.status === 'fulfilled' && profilesResult.status === 'fulfilled'
        ? { state: 'available', message: '' }
        : {
            state: 'unavailable',
            message: metadataResult.status === 'rejected'
              ? metadataResult.reason.message
              : profilesResult.reason.message,
          })

      const eventRequests = [
        ['PurchaseFunded', escrow.filters.PurchaseFunded()],
        ['DeliveryMarked', escrow.filters.DeliveryMarked()],
        ['DeliveryConfirmed', escrow.filters.DeliveryConfirmed()],
        ['PaymentReleased', escrow.filters.PaymentReleased()],
        ['DisputeRaised', escrow.filters.DisputeRaised()],
        ['DisputeResolved', escrow.filters.DisputeResolved()],
        ['RefundIssued', escrow.filters.RefundIssued()],
      ]
      const eventResults = await Promise.all(
        eventRequests.map(async ([name, filter]) => {
          const logs = await escrow.queryFilter(filter, 0, 'latest')
          return logs.slice(-HISTORY_LIMIT).map((log) => ({
            name,
            args: log.args,
            detail:
              name === 'RefundIssued'
                ? REFUND_REASONS[Number(log.args.reason)]
                : '',
            transactionHash: log.transactionHash,
            blockNumber: log.blockNumber,
            timestamp: log.blockNumber,
          }))
        }),
      )
      const groupedEvents = new Map()
      for (const event of eventResults.flat()) {
        const id = event.args.transactionId.toString()
        const entries = groupedEvents.get(id) ?? []
        entries.push(event)
        groupedEvents.set(id, entries)
      }
      const fundedEvents = [...(groupedEvents.entries())]
        .flatMap(([id, events]) => {
          const funded = events.find((event) => event.name === 'PurchaseFunded')
          return funded ? [{ id, funded, events }] : []
        })
        .sort((left, right) => {
          const leftId = BigInt(left.id)
          const rightId = BigInt(right.id)
          return leftId > rightId ? -1 : leftId < rightId ? 1 : 0
        })

      const latestBlock = await local.provider.getBlockNumber()
      const latestBlockData = await local.provider.getBlock(latestBlock)
      if (!latestBlockData) throw new Error('Could not read the current local block timestamp.')
      const blockTimes = new Map()
      const fullHistory = await Promise.all(
        fundedEvents.map(async ({ id, funded, events }) => {
          const record = await escrow.getTransaction(id)
          const blockNumber = funded.blockNumber
          if (!blockTimes.has(blockNumber)) {
            blockTimes.set(blockNumber, local.provider.getBlock(blockNumber))
          }
          const block = await blockTimes.get(blockNumber)
          return {
            id,
            buyer: record.buyer,
            seller: record.seller,
            listingId: record.listingId,
            amount: record.amount,
            fundedAt: record.fundedAt,
            deliveredAt: record.deliveredAt,
            disputedAt: record.disputedAt,
            status: Number(record.status),
            description: listingRecords.find(
              (listing) => listing?.id === record.listingId,
            )?.description,
            fundHash: funded.transactionHash,
            fundBlock: funded.blockNumber,
            fundTime: block?.timestamp,
            latestBlock,
            events: events
              .sort((left, right) => left.blockNumber - right.blockNumber)
              .map((event) => ({
                name: event.name,
                transactionHash: event.transactionHash,
                blockNumber: event.blockNumber,
              })),
          }
        }),
      )
      const history = fullHistory.slice(0, HISTORY_LIMIT)

      const currentAccount =
        account
          ? local.accounts.find((item) => item.toLowerCase() === account.toLowerCase()) ?? ''
          : ''
      const nextBalance = currentAccount ? await local.provider.getBalance(currentAccount) : 0n
      const nextVaultBalance = await local.provider.getBalance(deployment.escrow)
      const [nextLocked, nextProceeds] = history.reduce(
        ([locked, proceeds], item) => {
          if (
            ACTIVE_STATES.has(item.status) &&
            currentAccount &&
            (item.buyer.toLowerCase() === currentAccount.toLowerCase() ||
              item.seller.toLowerCase() === currentAccount.toLowerCase())
          ) {
            locked += item.amount
          }
          if (
            item.status === 3 &&
            currentAccount && item.seller.toLowerCase() === currentAccount.toLowerCase()
          ) {
            proceeds += item.amount
          }
          return [locked, proceeds]
        },
        [0n, 0n],
      )

      setListings(listingsWithMetadata.reverse())
      setTransactions(history)
      setVaultTransactions(fullHistory)
      setVaultBalance(nextVaultBalance)
      setVaultRefreshedAt(new Date())
      setBalance(nextBalance)
      setLockedBalance(nextLocked)
      setSellerProceeds(nextProceeds)
      setChainTimestamp(BigInt(latestBlockData.timestamp))
      setConnection({ status: 'connected', chainId: local.chainId, error: '' })
      if (!preserveFeedback) setFeedback((current) => current?.type === 'error' ? current : null)
      return { listings: listingsWithMetadata, history }
    } catch (error) {
      const message = describeError(error)
      setConnection({ status: 'offline', error: message })
      if (!preserveFeedback) {
        setFeedback({
          type: 'error',
          message: `Local blockchain unavailable: ${message}`,
        })
      }
      throw error
    }
  }, [account])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      refresh().catch(() => {})
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refresh])

  useEffect(() => {
    let active = true
    getCurrentUser()
      .then((user) => {
        if (active) {
          setAuthUser(user)
        }
      })
      .catch((error) => {
        if (active && error.status !== 401) setAuthError(error.message)
      })
    const handleExpiredSession = () => {
      setAuthUser(null)
      setIndexedOrderData(null)
      setIndexedOrderStatus({ state: 'signed-out', message: '' })
      setAuthMode('login')
      setAuthForm((current) => ({ ...current, password: '' }))
      setAuthError('Your sign-in expired. Sign in again to manage listing metadata.')
      setAuthModalOpen(true)
    }
    window.addEventListener('crowzon:session-expired', handleExpiredSession)
    return () => {
      active = false
      window.removeEventListener('crowzon:session-expired', handleExpiredSession)
    }
  }, [])

  useEffect(() => {
    let active = true
    if (!authUser) {
      setOwnedProducts([])
      setOwnedProductsStatus({ state: 'signed-out', message: '' })
      return () => { active = false }
    }

    Promise.resolve().then(() => {
      if (active) setOwnedProductsStatus({ state: 'loading', message: '' })
      return listMyProducts()
    }).then((products) => {
      if (!active) return
      setOwnedProducts(products)
      setOwnedProductsStatus({ state: 'available', message: '' })
    }).catch((error) => {
      if (!active) return
      setOwnedProducts([])
      setOwnedProductsStatus({ state: 'unavailable', message: error.message })
    })

    return () => { active = false }
  }, [authUser])

  useEffect(() => {
    if (!authUser || !account || connection.status !== 'connected') {
      return undefined
    }
    if (!authUser.assignedAccount) {
      let active = true
      Promise.resolve().then(() => {
        if (active) setIndexedOrderStatus({ state: 'unlinked', message: '' })
      })
      return () => { active = false }
    }
    let active = true
    let requestPending = false
    const loadOrders = () => {
      if (requestPending) return
      requestPending = true
      listOrders({
        chainId: Number(connection.chainId),
        deploymentId: deployment.deploymentId,
      }).then((data) => {
        if (!active) return
        setIndexedOrderData(data)
        setIndexedOrderStatus({ state: 'available', message: '' })
      }).catch((error) => {
        if (!active) return
        setIndexedOrderData(null)
        setIndexedOrderStatus({ state: 'unavailable', message: error.message })
      }).finally(() => {
        requestPending = false
      })
    }
    Promise.resolve().then(() => {
      if (!active) return
      setIndexedOrderStatus({ state: 'loading', message: '' })
      loadOrders()
    })
    const interval = window.setInterval(loadOrders, 10000)
    return () => {
      active = false
      window.clearInterval(interval)
    }
  }, [account, authUser, connection.chainId, connection.status])

  const filteredListings = useMemo(() => {
    const query = search.trim().toLowerCase()
    return listings.filter((listing) => {
      const presentation = getListingPresentation(listing.id, listing.description)
      const matchesCategory = category === 'All items' ||
        (listing.metadata?.category ?? presentation.category) === category
      const matchesSearch =
        !query ||
        listing.description.toLowerCase().includes(query) ||
        listing.metadata?.title?.toLowerCase().includes(query) ||
        listing.metadata?.description?.toLowerCase().includes(query) ||
        listing.sellerProfile?.displayName?.toLowerCase().includes(query) ||
        listing.seller.toLowerCase().includes(query)
      return listing.active && matchesCategory && matchesSearch
    })
  }, [category, listings, search])

  const accountTransactions = useMemo(
    () =>
      transactions.filter(
        (transaction) =>
          transaction.buyer.toLowerCase() === account.toLowerCase() ||
          transaction.seller.toLowerCase() === account.toLowerCase() ||
          account.toLowerCase() === deployment.accounts.disputeResolver.toLowerCase(),
      ),
    [account, transactions],
  )

  const accountListings = useMemo(
    () => getSellerStudioListings(
      listings,
      ownedProducts,
      authUser?.id,
      account,
      {
        chainId: Number(connection.chainId ?? deployment.chainId),
        marketplaceAddress: deployment.marketplace,
        deploymentId: deployment.deploymentId,
      },
    ),
    [account, authUser?.id, connection.chainId, listings, ownedProducts],
  )

  async function submitAuth(event) {
    event.preventDefault()
    setAuthBusy(true)
    setAuthError('')
    try {
      const credentials = authMode === 'register'
        ? authForm
        : { email: authForm.email, password: authForm.password }
      const user = authMode === 'register'
        ? await registerUser(credentials)
        : await loginUser(credentials)
      setAuthUser(user)
      setIndexedOrderData(null)
      setIndexedOrderStatus({ state: 'loading', message: '' })
      setAuthForm((current) => ({ ...current, password: '' }))
      setAuthModalOpen(false)
      setFeedback({
        type: 'success',
        message: `Signed in as ${user.displayName}. Your assigned local blockchain account is ${shortAddress(user.assignedAccount)}.`,
      })
      refresh({ preserveFeedback: true }).catch(() => {})
    } catch (error) {
      setAuthError(error.message)
      setFeedback({ type: 'error', message: `Authentication failed: ${error.message}` })
    } finally {
      setAuthBusy(false)
    }
  }

  async function signOut() {
    setAuthBusy(true)
    setAuthError('')
    try {
      await logoutUser()
      setAuthUser(null)
      setIndexedOrderData(null)
      setIndexedOrderStatus({ state: 'signed-out', message: '' })
      setAuthModalOpen(false)
      setFeedback({ type: 'success', message: 'You have signed out of your Crowzon profile.' })
    } catch (error) {
      setAuthError(error.message)
      setFeedback({ type: 'error', message: `Sign out failed: ${error.message}` })
    } finally {
      setAuthBusy(false)
    }
  }

  async function verifyAuthenticatedSession() {
    try {
      return await withAuthenticatedSession(getCurrentUser, (user) => {
        setAuthUser(user)
        return user
      })
    } catch (error) {
      if (error instanceof AuthenticationRequiredError) {
        setAuthUser(null)
        setAuthMode('login')
        setAuthError('Your session is missing or expired. Sign in or register to continue.')
        setAuthModalOpen(true)
        setFeedback({
          type: 'error',
          message: 'Log in or register before purchasing, selling, or taking escrow actions.',
        })
        return null
      }
      setFeedback({
        type: 'error',
        message: `Could not verify your Crowzon session: ${error.message}`,
      })
      return null
    }
  }

  async function execute(label, operation, successMessage) {
    const authenticatedUser = await verifyAuthenticatedSession()
    if (!authenticatedUser) return null
    if (connection.status !== 'connected') {
      setFeedback({ type: 'error', message: 'Connect to the local Hardhat node before sending a transaction.' })
      return null
    }
    setBusy(label)
    const confirmedReceipts = []
    setFeedback({ type: 'pending', message: label, receipts: confirmedReceipts })
    try {
      const local = await connectLocalChain()
      const assignedAccount = getAssignedBlockchainAccount(authenticatedUser, local.accounts)
      const signer = await getUnlockedLocalSigner(assignedAccount)
      const result = await operation(signer, (receipt) => {
        confirmedReceipts.push(receipt)
        setFeedback({
          type: 'pending',
          message: label,
          receipts: [...confirmedReceipts],
        })
      })
      const response = result?.wait ? result : result?.transaction
      if (!response?.wait) {
        throw new Error('The wallet did not return a transaction to confirm.')
      }
      const receipt = await response.wait()
      if (!receipt || Number(receipt.status) !== 1) {
        throw new Error('The transaction failed before confirmation.')
      }
      confirmedReceipts.push(receipt)
      setFeedback({
        type: 'success',
        message: successMessage,
        receipts: confirmedReceipts,
      })
      try {
        await refresh({ preserveFeedback: true })
      } catch (refreshError) {
        setFeedback({
          type: 'success',
          message: `${successMessage} The transaction is confirmed, but on-chain data could not be refreshed: ${describeError(refreshError)}`,
          receipts: confirmedReceipts,
        })
      }
      return receipt
    } catch (error) {
      const message = parseOnChainError(error)
      setFeedback({ type: 'error', message, receipts: confirmedReceipts })
      if (/network|fetch|connection|timeout/i.test(message)) {
        setConnection({ status: 'offline', error: message })
      }
      return null
    } finally {
      setBusy('')
    }
  }

  async function saveListingMetadata(listingId, { description, details, price, category, imageReference }) {
    const sessionUser = await withAuthenticatedSession(getCurrentUser, (user) => user)

    const metadataRecords = await listMyProducts()
    const existing = metadataRecords.find((item) => String(item.listingId) === String(listingId))
    const metadata = {
      title: description,
      description: details?.trim() || description,
      price: formatEth(price, 18),
      category,
      imageReference: imageReference || null,
    }
    if (existing) {
      if (Number(existing.sellerId) !== Number(sessionUser.id)) {
        throw new Error('Metadata for this on-chain listing belongs to a different signed-in user.')
      }
      await updateProductMetadata(existing.id, metadata)
    } else {
      await createProductMetadata({
        ...metadata,
        chainId: Number(connection.chainId),
        marketplaceAddress: deployment.marketplace,
        deploymentId: deployment.deploymentId,
        listingId: Number(listingId),
      })
    }
    await refresh({ preserveFeedback: true })
  }

  async function verifyListingManagement(listing) {
    const user = await verifyAuthenticatedSession()
    if (!user) return false
    try {
      const products = await listMyProducts()
      if (!ownsListingMetadata(products, listing.id, user.id, {
        chainId: Number(connection.chainId),
        marketplaceAddress: deployment.marketplace,
        deploymentId: deployment.deploymentId,
      })) {
        throw new Error('This listing is not recorded as owned by your authenticated Crowzon profile.')
      }
      if (listing.seller.toLowerCase() !== user.assignedAccount.toLowerCase()) {
        throw new Error('This legacy listing’s backend owner and on-chain seller account do not match; on-chain changes are disabled.')
      }
      return true
    } catch (error) {
      setFeedback({ type: 'error', message: error.message })
      return false
    }
  }

  async function saveMetadataAfterChainTransaction(receipt, values, listingId) {
    let linkedListingId = listingId
    if (linkedListingId === undefined) {
      const marketplace = getContracts(getProvider()).marketplace
      for (const log of receipt.logs) {
        try {
          const parsed = marketplace.interface.parseLog(log)
          if (parsed?.name === 'ListingCreated') {
            linkedListingId = parsed.args.listingId
            break
          }
        } catch {
          continue
        }
      }
    }
    if (linkedListingId === undefined) {
      setFeedback((current) => ({
        type: 'success',
        message: 'The blockchain listing was confirmed, but its listing ID could not be read for metadata linking.',
        receipts: current?.receipts ?? [receipt],
      }))
      return
    }
    try {
      await saveListingMetadata(linkedListingId, values)
      setFeedback((current) => ({
        type: 'success',
        message: `${current?.message || 'Blockchain listing confirmed.'} Persistent listing metadata saved.`,
        receipts: current?.receipts ?? [receipt],
      }))
    } catch (error) {
      setMetadataStatus({ state: 'unavailable', message: error.message })
      setFeedback((current) => ({
        type: 'success',
        message: `Blockchain listing confirmed, but off-chain metadata was not saved: ${error.message}`,
        receipts: current?.receipts ?? [receipt],
      }))
    }
  }

  async function createListing(event) {
    event.preventDefault()
    if (!(await verifyAuthenticatedSession())) return
    let price
    try {
      if (!newListing.description.trim()) throw new Error('Add a title or description for this listing.')
      if (!/^\d+(\.\d{1,18})?$/.test(newListing.price) || Number(newListing.price) <= 0) {
        throw new Error('Enter a positive ETH price with up to 18 decimal places.')
      }
      price = parseEthAmount(newListing.price)
    } catch (error) {
      setFeedback({ type: 'error', message: error.message })
      return
    }

    const receipt = await execute(
      'Creating listing on-chain…',
      (signer) => getContracts(signer).marketplace.createListing(newListing.description.trim(), price),
      'Your listing has been created on the local blockchain.',
    )
    if (receipt) {
      const listingMetadata = {
        description: newListing.description.trim(),
        details: newListing.details.trim(),
        price,
        category: newListing.category,
        imageReference: newListing.imageReference.trim(),
      }
      setNewListing({
        description: '',
        details: '',
        price: '',
        category: LISTING_CATEGORIES[0],
        imageReference: '',
      })
      await saveMetadataAfterChainTransaction(receipt, listingMetadata)
    }
  }

  async function updateListing(event) {
    event.preventDefault()
    if (!editListing) return
    if (!(await verifyListingManagement(editListing))) return
    let price
    try {
      if (!editListing.description.trim()) throw new Error('Add a title or description for this listing.')
      if (!/^\d+(\.\d{1,18})?$/.test(editListing.price) || Number(editListing.price) <= 0) {
        throw new Error('Enter a positive ETH price with up to 18 decimal places.')
      }
      price = parseEthAmount(editListing.price)
    } catch (error) {
      setFeedback({ type: 'error', message: error.message })
      return
    }

    const receipt = await execute(
      'Updating listing on-chain…',
      (signer) =>
        getContracts(signer).marketplace.updateListing(
          editListing.id,
          editListing.description.trim(),
          price,
        ),
      'Your listing has been updated on the local blockchain.',
    )
    if (receipt) {
      const listingMetadata = {
        description: editListing.description.trim(),
        details: editListing.metadata?.description ?? '',
        price,
        category: editListing.metadata?.category ||
          getListingPresentation(editListing.id, editListing.description).category,
        imageReference: editListing.metadata?.imageReference || '',
      }
      setEditListing(null)
      await saveMetadataAfterChainTransaction(receipt, listingMetadata, editListing.id)
    }
  }

  async function deactivateListing(listing) {
    if (!(await verifyListingManagement(listing))) return
    const receipt = await execute(
      'Deactivating listing…',
      (signer) => getContracts(signer).marketplace.deactivateListing(listing.id),
      'Your listing is now inactive on the local blockchain.',
    )
    if (receipt) setEditListing(null)
  }

  async function askToBuy(listing) {
    const user = await verifyAuthenticatedSession()
    if (user) setModal({ type: 'purchase', listing })
  }

  async function purchaseListing(listing) {
    setModal(null)
    await execute(
      'Purchasing with native ETH…',
      async (signer) => {
        const contracts = getContracts(signer)
        return contracts.marketplace.buyListing(listing.id, { value: listing.price })
      },
      'Purchase funded. ETH is held in escrow until delivery is confirmed.',
    )
  }

  async function runEscrowAction(transaction, action) {
    const operations = {
      markDelivered: (escrow) => escrow.markDelivered(transaction.id),
      confirmDelivery: (escrow) => escrow.confirmDelivery(transaction.id),
      cancelBeforeDelivery: (escrow) => escrow.cancelBeforeDelivery(transaction.id),
      raiseDispute: (escrow) => escrow.raiseDispute(transaction.id),
      resolveRelease: (escrow) => escrow.resolveDispute(transaction.id, true),
      resolveRefund: (escrow) => escrow.resolveDispute(transaction.id, false),
      refundUndelivered: (escrow) => escrow.refundUndelivered(transaction.id),
      refundUnresolvedDispute: (escrow) => escrow.refundUnresolvedDispute(transaction.id),
      finalizeAfterReviewPeriod: (escrow) => escrow.finalizeAfterReviewPeriod(transaction.id),
    }
    const messages = {
      markDelivered: 'Delivery has been recorded on-chain.',
      confirmDelivery: 'Delivery confirmed. Escrow funds were released to the seller.',
      cancelBeforeDelivery: 'Purchase cancelled. ETH has been refunded on-chain.',
      raiseDispute: 'Dispute raised on the local blockchain.',
      resolveRelease: 'Dispute resolved. Escrow funds were released to the seller.',
      resolveRefund: 'Dispute resolved. ETH has been refunded to the buyer.',
      refundUndelivered: 'The delivery timeout refund was confirmed on-chain.',
      refundUnresolvedDispute: 'The unresolved dispute refund was confirmed on-chain.',
      finalizeAfterReviewPeriod: 'Review timeout elapsed. Seller payment was released on-chain.',
    }

    setBusyId(transaction.id)
    try {
      await execute(
        'Waiting for escrow transaction…',
        (signer) => operations[action](getContracts(signer).escrow),
        messages[action],
      )
    } finally {
      setBusyId('')
    }
  }

  const lockedCount = transactions.filter(
    (transaction) =>
      ACTIVE_STATES.has(transaction.status) &&
      (transaction.buyer.toLowerCase() === account.toLowerCase() ||
        transaction.seller.toLowerCase() === account.toLowerCase()),
  ).length
  const vaultSummary = summarizeEscrowVault(vaultTransactions)
  const visibleVaultTransactions = vaultTransactions.filter((transaction) => {
    if (vaultFilter === 'active') return ACTIVE_STATES.has(transaction.status)
    if (vaultFilter === 'disputed') return transaction.status === 2
    if (vaultFilter === 'completed') return transaction.status === 3
    if (vaultFilter === 'refunded') return transaction.status === 4
    return true
  })

  return (
    <div className="app-shell" id="home">
      <div className="development-ribbon">
        <span className="ribbon-dot" />
        LOCAL DEVELOPMENT DEMO <span className="ribbon-divider">/</span> NATIVE ETH · NO REAL MONEY
      </div>
      <header className="site-header">
        <div className="header-inner">
          <Logo />
          <nav className={`main-nav ${mobileNavOpen ? 'nav-open' : ''}`} aria-label="Main navigation">
            {[
              ['market', 'Marketplace'],
              ['buyer', 'Buyer desk'],
              ['seller', 'Seller studio'],
              ['activity', 'Activity'],
              ['vault', 'Escrow Vault'],
            ].map(([target, label]) => (
              <button
                className={page === target ? 'nav-link is-current' : 'nav-link'}
                key={target}
                type="button"
                onClick={() => {
                  setPage(target)
                  setMobileNavOpen(false)
                  document.getElementById('page-content')?.scrollIntoView({ behavior: 'smooth' })
                }}
              >
                {label}
              </button>
            ))}
          </nav>
          <div className="header-tools">
            {authUser ? (
              <div className="auth-controls">
                <span className="auth-identity" title={authUser.email}>
                  <strong>{authUser.displayName}</strong>
                  <small>Signed in</small>
                </span>
                <button className="auth-button" type="button" disabled={authBusy} onClick={signOut}>
                  Sign out
                </button>
              </div>
            ) : (
              <div className="auth-controls">
                <button
                  className="auth-button"
                  type="button"
                  onClick={() => {
                    setAuthError('')
                    setAuthMode('login')
                    setAuthModalOpen(true)
                  }}
                >
                  Login
                </button>
                <button
                  className="auth-button"
                  type="button"
                  onClick={() => {
                    setAuthError('')
                    setAuthMode('register')
                    setAuthModalOpen(true)
                  }}
                >
                  Register
                </button>
              </div>
            )}
            <div className="account-picker">
              <span className="account-picker-label">Assigned blockchain account</span>
              <span className={`connection-dot ${connection.status}`} />
              <span className="assigned-account-value">
                {account ? shortAddress(account) : 'Sign in to receive an account'}
              </span>
            </div>
            <button
              className="icon-button refresh-button"
              type="button"
              aria-label="Refresh local blockchain connection"
              title="Reconnect and refresh on-chain data"
              onClick={() => refresh().catch(() => {})}
            >
              <Icon name="refresh" />
            </button>
            <button
              className="icon-button menu-toggle"
              type="button"
              aria-label="Toggle navigation"
              onClick={() => setMobileNavOpen((open) => !open)}
            >
              <Icon name="menu" />
            </button>
          </div>
        </div>
      </header>

      <main id="page-content">
        <section className={`chain-banner ${connection.status === 'connected' ? 'chain-live' : 'chain-offline'}`}>
          <div className="chain-banner-mark"><Icon name="shield" size={19} /></div>
          <div className="chain-banner-copy">
            <strong>
              {connection.status === 'connected'
                ? 'Connected to local Hardhat'
                : connection.status === 'connecting'
                  ? 'Connecting to the local blockchain…'
                  : 'Local blockchain is unavailable'}
            </strong>
            <span>
              {connection.status === 'connected'
                ? `Chain ${connection.chainId} · Unlocked development accounts · For demo use only`
                : connection.error || 'Start the local Hardhat node, then reconnect.'}
            </span>
          </div>
          {connection.status !== 'connected' && (
            <button className="button button-outline button-small" type="button" onClick={() => refresh().catch(() => {})}>
              Retry connection
            </button>
          )}
          <span className="chain-badge"><span className={`connection-dot ${connection.status}`} />{connection.status === 'connected' ? 'LOCAL NODE' : 'OFFLINE'}</span>
        </section>

        {feedback && (
          <div className={`feedback feedback-${feedback.type}`} role={feedback.type === 'error' ? 'alert' : 'status'}>
            <span className="feedback-symbol">
              {feedback.type === 'pending' ? <span className="spinner" /> : feedback.type === 'error' ? '!' : '✓'}
            </span>
            <div className="feedback-copy">
              <strong>{feedback.type === 'pending' ? 'Transaction pending' : feedback.type === 'error' ? 'Action needs attention' : 'Transaction confirmed'}</strong>
              <span>{feedback.message}</span>
              {feedback.receipts?.map((receipt) => (
                <span className="feedback-receipt" key={receipt.hash}>
                  Block #{receipt.blockNumber} · <code>{shortAddress(receipt.hash)}</code>
                  <button type="button" onClick={() => navigator.clipboard?.writeText(receipt.hash)}>Copy hash</button>
                </span>
              ))}
            </div>
            <button className="feedback-close" type="button" aria-label="Dismiss message" onClick={() => setFeedback(null)}>
              <Icon name="close" size={17} />
            </button>
          </div>
        )}

        {page === 'market' && (
          <>
            <section className="hero-section">
              <div className="hero-content">
                <span className="eyebrow"><span className="eyebrow-line" />THE PEER-TO-PEER MARKETPLACE</span>
                <h1>Good things<br />happen <em>directly.</em></h1>
                <p>Discover useful finds from real people. Every purchase is protected by transparent, on-chain escrow.</p>
                <button className="button button-dark" type="button" onClick={() => document.getElementById('marketplace')?.scrollIntoView({ behavior: 'smooth' })}>
                  Explore the marketplace <Icon name="arrow" size={17} />
                </button>
                <div className="hero-footnote"><span>01</span> Local demo · ETH-only escrow · No real-world payments</div>
              </div>
              <div className="hero-visual" aria-label="Crowzon peer-to-peer escrow illustration">
                <div className="visual-grid" />
                <div className="orbit orbit-one" />
                <div className="orbit orbit-two" />
                <div className="visual-card visual-card-back">
                  <span className="mini-card-label">DIRECT TRADE</span><span className="mini-card-shape">✳</span>
                </div>
                <div className="visual-card visual-card-main">
                  <div className="visual-card-top"><span>SECURED BY</span><span className="visual-lock"><Icon name="lock" size={17} /></span></div>
                  <div className="visual-emblem">C<span>↔</span>C</div>
                  <div className="visual-card-bottom"><strong>Trust, built in.</strong><span>SMART CONTRACT ESCROW</span></div>
                </div>
                <div className="floating-chip chip-top"><span className="chip-dot" />Buyer protected</div>
                <div className="floating-chip chip-bottom"><Icon name="shield" size={15} /> Seller address on-chain</div>
                <div className="visual-stamp">TRADE<br />DIRECT</div>
              </div>
              <div className="hero-bottom-label"><span>SCROLL TO DISCOVER</span><span className="hero-bottom-rule" /></div>
            </section>

            <section className="trust-strip" aria-label="Marketplace principles">
              <div><span className="trust-number">01</span><span><strong>Direct by design</strong><small>No middlemen. Just people trading.</small></span></div>
              <div><span className="trust-number">02</span><span><strong>Escrow protected</strong><small>ETH stays locked until delivery.</small></span></div>
              <div><span className="trust-number">03</span><span><strong>On-chain transparent</strong><small>Every confirmed action has a receipt.</small></span></div>
            </section>

            <section className="market-section section-wrap" id="marketplace">
              <div className="section-heading">
                <div>
                  <span className="eyebrow"><span className="eyebrow-line" />THE MARKETPLACE</span>
                  <h2>Find your next <em>good thing.</em></h2>
                  <p>Listings and prices are read from the local Crowzon marketplace contract.</p>
                </div>
                <div className="listing-count"><strong>{listings.filter((item) => item.active).length.toString().padStart(2, '0')}</strong><span>ACTIVE<br />LISTINGS</span></div>
              </div>
              <div className="market-controls">
                <label className="search-field">
                  <Icon name="search" size={19} />
                  <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search listings or sellers…" />
                  <kbd>⌕</kbd>
                </label>
                <div className="category-tabs" aria-label="Filter listings by category">
                  {CATEGORIES.map((item) => (
                    <button
                      className={category === item ? 'category-tab selected' : 'category-tab'}
                      type="button"
                      key={item}
                      onClick={() => setCategory(item)}
                    >
                      {item === 'All items' && <Icon name="grid" size={14} />}{item}
                    </button>
                  ))}
                </div>
              </div>
              <p className="metadata-notice"><Icon name="tag" size={14} /> Seller, ETH price, and availability come from the marketplace contract. Category, image, and profile are off-chain metadata.{metadataStatus.state === 'loading' ? ' Loading saved metadata…' : ''}{metadataStatus.state === 'unavailable' ? ` Saved metadata unavailable: ${metadataStatus.message}. On-chain listings remain available.` : ''}</p>
              {connection.status === 'connecting' && listings.length === 0 ? (
                <div className="empty-state"><span className="spinner spinner-large" /><strong>Reading the local marketplace…</strong><span>Fetching listing records from CrowzonMarketplace.</span></div>
              ) : filteredListings.length > 0 ? (
                <div className="listing-grid">
                  {filteredListings.map((listing) => (
                    <ListingCard
                      key={listing.id.toString()}
                      listing={listing}
                      sellerProfile={listing.sellerProfile}
                      canManage={accountListings.some((owned) =>
                        owned.id === listing.id && owned.chainManageable,
                      )}
                      isOwnBlockchainAccount={Boolean(
                        account && listing.seller.toLowerCase() === account.toLowerCase(),
                      )}
                      onBuy={askToBuy}
                      onEdit={(item) => setEditListing({ ...item, price: formatEth(item.price, 18) })}
                      isBusy={Boolean(busy)}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <span className="empty-icon"><Icon name="box" size={24} /></span>
                  <strong>{connection.status === 'connected' ? 'No matching on-chain listings yet.' : 'Connect to load marketplace listings.'}</strong>
                  <span>{connection.status === 'connected' ? 'Try another search, or add the first listing in Seller studio.' : 'The marketplace never substitutes mock listings when the node is offline.'}</span>
                </div>
              )}
            </section>
          </>
        )}

        {page === 'buyer' && (
          <section className="dashboard section-wrap">
            <PageHeading eyebrow="YOUR BUYER DESK" title={<>Trade with<br /><em>confidence.</em></>} description="Your ETH balance and escrow purchases are read directly from the local contracts." />
            <div className="stats-grid">
              <StatCard icon="wallet" label="Available balance" value={`${formatEth(balance)} ETH`} note="Native local-chain balance" tone="lavender" />
              <StatCard icon="lock" label="Currently in escrow" value={`${formatEth(lockedBalance)} ETH`} note={`${lockedCount} open transaction${lockedCount === 1 ? '' : 's'} involving this account`} tone="peach" />
              <StatCard icon="bag" label="Your purchases" value={transactions.filter((item) => item.buyer.toLowerCase() === account.toLowerCase()).length.toString().padStart(2, '0')} note="Recorded by CrowzonEscrow" tone="mint" />
            </div>
            <div className="dashboard-columns">
              <div className="dashboard-main-panel">
                <PanelHeading icon="bag" title="Purchase & escrow history" aside={`${accountTransactions.length} RECORDS`} />
                {accountTransactions.length ? (
                  <div className="transaction-list">
                    {accountTransactions.map((transaction) => (
                      <TransactionCard
                        key={transaction.id}
                        transaction={transaction}
                        account={account}
                        resolver={deployment.accounts.disputeResolver}
                        busyId={busyId}
                        chainTimestamp={chainTimestamp}
                        runAction={runEscrowAction}
                      />
                    ))}
                  </div>
                ) : <EmptyPanel message="Your escrow history will appear here after your first purchase." />}
              </div>
              <aside className="side-note-card">
                <span className="side-note-icon"><Icon name="shield" size={21} /></span>
                <span className="eyebrow">HOW ESCROW WORKS</span>
                <h3>Your ETH stays<br /><em>in your corner.</em></h3>
                <ol className="escrow-steps">
                  <li><span>01</span><div><strong>Fund & purchase</strong><small>Native ETH moves into the contract escrow.</small></div></li>
                  <li><span>02</span><div><strong>Seller marks delivery</strong><small>Your purchase status updates on-chain.</small></div></li>
                  <li><span>03</span><div><strong>Confirm to release</strong><small>Confirm delivery to release ETH to seller.</small></div></li>
                </ol>
                <div className="side-note-foot">7-day review period · 30-day dispute timeout</div>
              </aside>
            </div>
          </section>
        )}

        {page === 'seller' && (
          <section className="dashboard section-wrap">
            <PageHeading eyebrow="YOUR SELLER STUDIO" title={<>Make room for<br /><em>good trades.</em></>} description="Publish and manage listings on the live local Crowzon marketplace contract." />
            <div className="stats-grid">
              <StatCard icon="tag" label="Your listings" value={accountListings.length.toString().padStart(2, '0')} note="Read from CrowzonMarketplace" tone="lavender" />
              <StatCard icon="wallet" label="ETH balance" value={`${formatEth(balance)} ETH`} note="Local development wallet balance" tone="mint" />
              <StatCard icon="shield" label="Seller proceeds" value={`${formatEth(sellerProceeds)} ETH`} note="Completed escrow releases to this account" tone="peach" />
            </div>
            <div className="seller-layout">
              <div className="dashboard-main-panel seller-listings-panel">
                <PanelHeading icon="grid" title="Your listings" aside={`${accountListings.length} TOTAL`} />
                {ownedProductsStatus.state === 'loading' && <p className="metadata-notice">Loading listings linked to your authenticated profile…</p>}
                {ownedProductsStatus.state === 'unavailable' && <p className="metadata-notice">Seller Studio could not verify listing ownership: {ownedProductsStatus.message}</p>}
                {accountListings.length ? (
                  <div className="seller-listings">
                    {accountListings.map((listing) => (
                      <div className="seller-listing-row" key={listing.id.toString()}>
                        <span className={`seller-listing-art tone-${getListingPresentation(listing.id, listing.description).tone}`}>{getListingPresentation(listing.id, listing.description).icon}</span>
                        <span className="seller-listing-title"><strong>{listing.description}</strong><small>Listing #{listing.id.toString()} · {shortAddress(listing.seller)}</small></span>
                        <strong className="seller-listing-price">{formatEth(listing.price)} ETH</strong>
                        <span className={`availability ${listing.active ? 'is-active' : 'is-inactive'}`}><span />{listing.active ? 'Active' : 'Inactive'}</span>
                        {listing.active && listing.chainManageable && <button className="icon-button listing-edit-button" type="button" aria-label={`Edit ${listing.description}`} onClick={() => setEditListing({ ...listing, price: formatEth(listing.price, 18) })}><Icon name="edit" size={16} /></button>}
                        {listing.active && !listing.chainManageable && <small className="ownership-warning">Backend owner and on-chain seller differ; actions disabled.</small>}
                      </div>
                    ))}
                  </div>
                ) : <EmptyPanel message={ownedProductsStatus.state === 'loading' ? 'Checking your authenticated listing ownership.' : 'Listings linked to your authenticated Crowzon profile will show up here.'} />}
              </div>
              <form className="create-listing-card" onSubmit={createListing}>
                <div className="form-card-head"><span className="form-card-icon"><Icon name="plus" size={20} /></span><span className="eyebrow">LIST SOMETHING GOOD</span></div>
                <h3>Create a listing</h3>
                <p>The listing is created on-chain; category, image reference, and profile are saved separately as off-chain metadata.</p>
                <label className="form-label" htmlFor="listing-title">Listing title or description</label>
                <textarea id="listing-title" rows="3" maxLength="180" placeholder="What are you offering?" value={newListing.description} onChange={(event) => setNewListing((current) => ({ ...current, description: event.target.value }))} />
                <div className="field-meta"><span>Short and descriptive works best.</span><span>{newListing.description.length}/180</span></div>
                <label className="form-label" htmlFor="listing-details">Additional product details (off-chain)</label>
                <textarea
                  id="listing-details"
                  rows="4"
                  maxLength="2000"
                  placeholder="Add condition, dimensions, included items, or service details."
                  value={newListing.details}
                  onChange={(event) => setNewListing((current) => ({ ...current, details: event.target.value }))}
                />
                <div className="field-meta"><span>Saved as marketplace metadata, not written to the contract.</span><span>{newListing.details.length}/2000</span></div>
                <label className="form-label" htmlFor="listing-category">Off-chain category</label>
                <select
                  className="metadata-input"
                  id="listing-category"
                  value={newListing.category}
                  onChange={(event) => setNewListing((current) => ({ ...current, category: event.target.value }))}
                >
                  {LISTING_CATEGORIES.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
                <label className="form-label" htmlFor="listing-image-reference">Image URL or local path (optional)</label>
                <input
                  className="metadata-input"
                  id="listing-image-reference"
                  type="text"
                  placeholder="https://…"
                  value={newListing.imageReference}
                  onChange={(event) => setNewListing((current) => ({ ...current, imageReference: event.target.value }))}
                />
                <label className="form-label" htmlFor="listing-price">Price in ETH</label>
                <div className="price-input"><input id="listing-price" inputMode="decimal" placeholder="0.00" value={newListing.price} onChange={(event) => setNewListing((current) => ({ ...current, price: event.target.value }))} /><span>ETH</span></div>
                <button className="button button-dark create-submit" type="submit" disabled={Boolean(busy) || connection.status !== 'connected'}>
                  {busy === 'Creating listing on-chain…' ? 'Waiting for confirmation…' : 'Publish listing'} <Icon name="arrow" size={16} />
                </button>
                <span className="form-disclaimer"><Icon name="shield" size={14} /> Blockchain listing uses local ETH. Sign in to save and manage off-chain metadata; the selected development wallet is separate and unverified.</span>
              </form>
            </div>
          </section>
        )}

        {page === 'vault' && (
          <section className="dashboard section-wrap escrow-vault">
            <PageHeading
              eyebrow="CROWZON ESCROW"
              title={<>Escrow<br /><em>Vault.</em></>}
              description="A live view of the deployed escrow contract, on-chain payment records, and funds currently held."
            />
            <div className="vault-toolbar">
              <div>
                <span className="vault-chain-label">NETWORK</span>
                <strong>{connection.status === 'connected' ? `Chain ID ${connection.chainId}` : 'Chain unavailable'}</strong>
                <small>Read-only data from the local blockchain</small>
              </div>
              <button
                className="button button-outline button-small"
                type="button"
                disabled={connection.status !== 'connected'}
                onClick={() => refresh().catch(() => {})}
              >
                <Icon name="refresh" size={15} /> Refresh vault
              </button>
            </div>
            <div className="stats-grid vault-stats">
              <StatCard
                icon="wallet"
                label="Total contract balance"
                value={`${formatEth(vaultBalance)} ETH`}
                note="Current native ETH held at the escrow address"
                tone="lavender"
              />
              <StatCard
                icon="lock"
                label="Active escrows"
                value={String(vaultSummary.activeCount).padStart(2, '0')}
                note="Funded, delivered, or disputed"
                tone="mint"
              />
              <StatCard
                icon="shield"
                label="Active escrow liabilities"
                value={`${formatEth(vaultSummary.activeLiabilities)} ETH`}
                note="Sum of on-chain amounts in active states"
                tone="peach"
              />
            </div>
            <div className="vault-address-panel">
              <span className="vault-address-icon"><Icon name="lock" size={18} /></span>
              <div>
                <span className="vault-chain-label">DEPLOYED ESCROW CONTRACT</span>
                <code>{deployment.escrow}</code>
              </div>
              <span className="vault-address-network">Chain {connection.chainId ?? '—'}</span>
            </div>
            <p className="vault-balance-note">
              Contract balance and active liabilities are separate on-chain measurements. The balance may include funds outside current escrow records; it is not presented as entirely owed to active buyers.
            </p>
            <div className="dashboard-main-panel vault-records-panel">
              <div className="vault-records-heading">
                <PanelHeading
                  icon="box"
                  title="Escrow records"
                  aside={`${vaultTransactions.length} ON-CHAIN RECORDS`}
                />
                <div className="vault-filters" role="group" aria-label="Filter escrow records">
                  {[
                    ['all', 'All'],
                    ['active', 'Active'],
                    ['disputed', 'Disputed'],
                    ['completed', 'Completed'],
                    ['refunded', 'Refunded'],
                  ].map(([filter, label]) => (
                    <button
                      className={vaultFilter === filter ? 'vault-filter is-selected' : 'vault-filter'}
                      key={filter}
                      type="button"
                      onClick={() => setVaultFilter(filter)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {connection.status === 'connecting' && vaultTransactions.length === 0 ? (
                <div className="empty-panel"><strong>Reading escrow records…</strong><span>Fetching contract state and payment events from the blockchain.</span></div>
              ) : visibleVaultTransactions.length ? (
                <div className="vault-record-list">
                  {visibleVaultTransactions.map((transaction) => (
                    <article className="vault-record" key={transaction.id}>
                      <div className="vault-record-top">
                        <div>
                          <span className="transaction-id">PAYMENT #{transaction.id}</span>
                          <h3>Listing #{transaction.listingId.toString()}</h3>
                        </div>
                        <span className={`status-pill status-${STATUS[transaction.status]?.toLowerCase()}`}>
                          {STATUS[transaction.status]}
                        </span>
                      </div>
                      <div className="vault-record-data">
                        <div><span>Amount</span><strong>{formatEth(transaction.amount)} ETH</strong></div>
                        <div><span>Buyer</span><code title={transaction.buyer}>{transaction.buyer}</code></div>
                        <div><span>Seller</span><code title={transaction.seller}>{transaction.seller}</code></div>
                        <div><span>Funded</span><strong>{formatDate(transaction.fundedAt)}</strong></div>
                      </div>
                      <div className="vault-event-list">
                        {transaction.events.map((event) => (
                          <div className="vault-event" key={`${transaction.id}-${event.name}-${event.transactionHash}`}>
                            <span>{event.name}</span>
                            <span>Block #{event.blockNumber}</span>
                            <code title={event.transactionHash}>{shortAddress(event.transactionHash)}</code>
                          </div>
                        ))}
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="empty-panel">
                  <strong>{vaultTransactions.length ? 'No records in this status.' : 'No escrow records found.'}</strong>
                  <span>{vaultTransactions.length ? 'Choose another status filter to view the remaining records.' : 'The vault lists only payment records returned by the deployed contract events.'}</span>
                </div>
              )}
            </div>
            <div className="chain-data-foot vault-updated">
              <span><Icon name="shield" size={16} /> Payment IDs, participants, and states read from CrowzonEscrow</span>
              <span>{vaultRefreshedAt ? `Last refreshed ${vaultRefreshedAt.toLocaleTimeString()}` : 'Waiting for first blockchain read'}</span>
            </div>
          </section>
        )}

        {page === 'activity' && (
          <section className="dashboard section-wrap">
            <PageHeading eyebrow="THE ON-CHAIN RECORD" title={<>A clear trail<br /><em>of every trade.</em></>} description="Transaction state is read from escrow. Event names, hashes and block numbers are from local contract logs." />
            <div className="activity-toolbar">
              <span className="activity-scope"><span className="connection-dot connected" />Live escrow state for selected development account</span>
              <button className="button button-outline button-small" type="button" onClick={() => refresh().catch(() => {})}><Icon name="refresh" size={15} /> Refresh chain data</button>
            </div>
            <div className="dashboard-main-panel activity-panel indexed-order-panel">
              <PanelHeading
                icon="clock"
                title="Persistent indexed escrow events"
                aside={indexedOrderStatus.state === 'available'
                  ? `${indexedOrderData?.orders?.length ?? 0} RECORDS`
                  : indexedOrderStatus.state.toUpperCase()}
              />
              <p className="indexed-order-note">
                Public event history for your account-assigned address {account ? shortAddress(account) : 'is unavailable'}. Current escrow status is read directly from the contract.
              </p>
              {indexedOrderStatus.state === 'signed-out' ? (
                <div className="empty-panel">
                  <strong>Sign in to query indexed order history.</strong>
                  <span>Your Crowzon profile is not linked to or proof of ownership of the selected development wallet.</span>
                  <button className="button button-outline button-small" type="button" onClick={() => { setAuthError(''); setAuthMode('login'); setAuthModalOpen(true) }}>Sign in</button>
                </div>
              ) : indexedOrderStatus.state === 'unlinked' ? (
                <div className="empty-panel">
                  <strong>No blockchain account is assigned to this profile.</strong>
                  <span>Reconnect to the local blockchain and sign in again to validate its account assignment.</span>
                </div>
              ) : indexedOrderStatus.state === 'loading' ? (
                <div className="empty-panel"><span className="spinner" /><strong>Loading indexed event history…</strong></div>
              ) : indexedOrderStatus.state === 'unavailable' ? (
                <div className="empty-panel">
                  <strong>Indexed history is unavailable.</strong>
                  <span>{indexedOrderStatus.message || 'The API or local-chain indexer has not reported history yet.'}</span>
                </div>
              ) : indexedOrderData?.orders?.length ? (
                <div className="transaction-list">
                  {indexedOrderData.orders.map((order) => {
                    const liveRecord = transactions.find((item) => String(item.id) === order.transactionId)
                    return (
                      <article className="transaction-card indexed-order-card" key={order.transactionId}>
                        <div className="transaction-icon"><Icon name={order.complete ? 'box' : 'clock'} size={19} /></div>
                        <div className="transaction-main">
                          <div className="transaction-heading">
                            <div>
                              <span className="transaction-id">Indexed escrow transaction #{order.transactionId}</span>
                              <h3>{order.complete ? `Listing #${order.listingId}` : 'Funding event not indexed yet'}</h3>
                            </div>
                            {liveRecord && <span className={`status-pill status-${STATUS[liveRecord.status]?.toLowerCase()}`}>{STATUS[liveRecord.status]}</span>}
                          </div>
                          <div className="transaction-meta">
                            <span>{order.buyerAddress ? `Buyer ${shortAddress(order.buyerAddress)}` : 'Buyer unavailable'}</span>
                            <span>{order.sellerAddress ? `Seller ${shortAddress(order.sellerAddress)}` : 'Seller unavailable'}</span>
                            <span>{liveRecord ? `Live escrow state: ${STATUS[liveRecord.status]}` : 'Live escrow state unavailable'}</span>
                          </div>
                          <div className="event-trail">
                            {order.events.map((event) => (
                              <span key={`${event.transactionHash}-${event.logIndex}`} title={event.transactionHash}>
                                {event.name} · block #{event.blockNumber} · log {event.logIndex} · <code>{shortAddress(event.transactionHash)}</code>
                              </span>
                            ))}
                          </div>
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <div className="empty-panel">
                  <strong>{indexedOrderData?.indexer?.available ? 'No indexed escrow events for this address.' : 'The event indexer has not completed its first scan.'}</strong>
                  <span>Existing on-chain transactions remain available in the live contract history below.</span>
                </div>
              )}
            </div>
            {accountTransactions.length ? (
              <div className="dashboard-main-panel activity-panel">
                <div className="activity-list">
                  {accountTransactions.map((transaction) => (
                    <TransactionCard
                      key={transaction.id}
                      transaction={transaction}
                      account={account}
                      resolver={deployment.accounts.disputeResolver}
                      busyId={busyId}
                      chainTimestamp={chainTimestamp}
                      runAction={runEscrowAction}
                    />
                  ))}
                </div>
              </div>
            ) : <div className="dashboard-main-panel"><EmptyPanel message="No escrow transactions involve this local account yet." /></div>}
            <div className="chain-data-foot">
              <span><Icon name="shield" size={16} /> Source: local Hardhat node · Chain ID 31337</span>
              <span>Showing up to {HISTORY_LIMIT} most recent purchase records</span>
            </div>
          </section>
        )}
      </main>

      <footer className="site-footer">
        <div className="footer-main">
          <div className="footer-brand-block"><Logo compact /><p>Trade Directly.<br />Trust the Blockchain.</p></div>
          <div className="footer-links"><span>BUILT FOR THE DEMO</span><p>Real smart contracts. Local development ETH only.<br />Local development network only.</p></div>
          <div className="footer-chain"><span className={`connection-dot ${connection.status}`} />{connection.status === 'connected' ? `CONNECTED · CHAIN ${connection.chainId}` : 'LOCAL CHAIN OFFLINE'}</div>
        </div>
        <div className="footer-bottom"><span>© 2026 Crowzon course project</span><span>ETH in this demo is local test value only and not real currency.</span></div>
      </footer>

      {authModalOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setAuthModalOpen(false)}>
          <form className="dialog-card auth-dialog" onSubmit={submitAuth}>
            <button className="dialog-close icon-button" type="button" aria-label="Close sign-in dialog" onClick={() => setAuthModalOpen(false)}><Icon name="close" /></button>
            <span className="dialog-icon"><Icon name="lock" size={22} /></span>
            <span className="eyebrow">CROWZON ACCOUNT</span>
            <h2>{authMode === 'register' ? 'Create your profile' : 'Welcome back'}</h2>
            <p>Your Crowzon login protects off-chain listing metadata. It is separate from the selected local blockchain account.</p>
            {authMode === 'register' && (
              <>
                <label className="form-label" htmlFor="auth-display-name">Display name</label>
                <input
                  className="metadata-input"
                  id="auth-display-name"
                  autoComplete="name"
                  maxLength={80}
                  required
                  value={authForm.displayName}
                  onChange={(event) => setAuthForm((current) => ({ ...current, displayName: event.target.value }))}
                />
              </>
            )}
            <label className="form-label" htmlFor="auth-email">Email</label>
            <input
              className="metadata-input"
              id="auth-email"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              value={authForm.email}
              onChange={(event) => setAuthForm((current) => ({ ...current, email: event.target.value }))}
            />
            <label className="form-label" htmlFor="auth-password">Password</label>
            <input
              className="metadata-input"
              id="auth-password"
              type="password"
              autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
              maxLength={128}
              required
              value={authForm.password}
              onChange={(event) => setAuthForm((current) => ({ ...current, password: event.target.value }))}
            />
            {authError && <div className="auth-error" role="alert">{authError}</div>}
            <button className="button button-dark dialog-action" type="submit" disabled={authBusy}>
              {authBusy ? 'Please wait…' : authMode === 'register' ? 'Create account' : 'Sign in'}
            </button>
            <button
              className="dialog-cancel"
              type="button"
              disabled={authBusy}
              onClick={() => {
                setAuthMode((current) => current === 'login' ? 'register' : 'login')
                setAuthError('')
              }}
            >
              {authMode === 'login' ? 'New to Crowzon? Create an account' : 'Already registered? Sign in'}
            </button>
            <div className="dialog-warning"><Icon name="shield" size={16} /> Local demo account only. Your selected development wallet is not verified or linked by this login.</div>
          </form>
        </div>
      )}

      {modal?.type === 'purchase' && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setModal(null)}>
          <section className="dialog-card" role="dialog" aria-modal="true" aria-labelledby="purchase-title">
            <button className="dialog-close icon-button" type="button" aria-label="Close purchase confirmation" onClick={() => setModal(null)}><Icon name="close" /></button>
            <span className="dialog-icon"><Icon name="lock" size={22} /></span>
            <span className="eyebrow">REVIEW YOUR PURCHASE</span>
            <h2 id="purchase-title">{modal.listing.description}</h2>
            <p>Native ETH will be held by the local escrow contract until delivery is confirmed.</p>
            <div className="purchase-receipt">
              <span><span>Seller</span><strong>{shortAddress(modal.listing.seller)}</strong></span>
              <span><span>Purchase amount</span><strong>{formatEth(modal.listing.price)} ETH</strong></span>
              <span><span>Escrow contract</span><strong>{shortAddress(deployment.escrow)}</strong></span>
            </div>
            <div className="dialog-warning"><Icon name="shield" size={16} /> Local demo transaction · no INR or real cryptocurrency</div>
            <button className="button button-dark dialog-action" type="button" disabled={Boolean(busy) || connection.status !== 'connected'} onClick={() => purchaseListing(modal.listing)}>
              Pay with ETH <Icon name="arrow" size={16} />
            </button>
            <button className="dialog-cancel" type="button" onClick={() => setModal(null)}>Not right now</button>
          </section>
        </div>
      )}

      {editListing && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setEditListing(null)}>
          <form className="dialog-card edit-dialog" onSubmit={updateListing}>
            <button className="dialog-close icon-button" type="button" aria-label="Close listing editor" onClick={() => setEditListing(null)}><Icon name="close" /></button>
            <span className="dialog-icon"><Icon name="edit" size={22} /></span>
            <span className="eyebrow">SELLER CONTROLS · LISTING #{editListing.id.toString()}</span>
            <h2>Manage your listing</h2>
            <label className="form-label" htmlFor="edit-listing-description">Description stored on-chain</label>
            <textarea id="edit-listing-description" rows="3" maxLength="180" value={editListing.description} onChange={(event) => setEditListing((current) => ({ ...current, description: event.target.value }))} />
            <label className="form-label" htmlFor="edit-listing-details">Additional product details (off-chain)</label>
            <textarea
              id="edit-listing-details"
              rows="4"
              maxLength="2000"
              value={editListing.metadata?.description ?? editListing.description}
              onChange={(event) => setEditListing((current) => ({
                ...current,
                metadata: { ...current.metadata, description: event.target.value },
              }))}
            />
            <label className="form-label" htmlFor="edit-listing-price">ETH price</label>
            <div className="price-input"><input id="edit-listing-price" inputMode="decimal" value={editListing.price} onChange={(event) => setEditListing((current) => ({ ...current, price: event.target.value }))} /><span>ETH</span></div>
            <div className="edit-dialog-actions">
              <button className="button button-dark" type="submit" disabled={Boolean(busy) || connection.status !== 'connected'}>Save changes</button>
              <button className="button button-danger-soft" type="button" disabled={Boolean(busy) || connection.status !== 'connected'} onClick={() => deactivateListing(editListing)}>Deactivate</button>
            </div>
            <span className="form-disclaimer">Both actions create actual local-chain transactions.</span>
          </form>
        </div>
      )}
    </div>
  )
}

function PageHeading({ eyebrow, title, description }) {
  return (
    <div className="page-heading">
      <div><span className="eyebrow"><span className="eyebrow-line" />{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
    </div>
  )
}

function PanelHeading({ icon, title, aside }) {
  return <div className="panel-heading"><span className="panel-icon"><Icon name={icon} size={17} /></span><h2>{title}</h2><span className="panel-aside">{aside}</span></div>
}

function EmptyPanel({ message }) {
  return <div className="empty-panel"><span className="empty-icon"><Icon name="box" size={23} /></span><strong>Nothing here just yet.</strong><span>{message}</span></div>
}

export default App
