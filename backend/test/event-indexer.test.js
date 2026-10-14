import assert from 'node:assert/strict'
import test from 'node:test'
import { Interface } from 'ethers'
import { openDatabase } from '../src/database.js'
import { createEventIndexer } from '../src/event-indexer.js'

const deploymentId = '1bdb4854-c6c1-4d14-9840-5befb41bf27e'
const alternateDeploymentId = '2bdb4854-c6c1-4d14-9840-5befb41bf27e'
const marketplaceAddress = '0x1111111111111111111111111111111111111111'
const escrowAddress = '0x2222222222222222222222222222222222222222'
const seller = '0x3333333333333333333333333333333333333333'
const buyer = '0x4444444444444444444444444444444444444444'
const marketplaceInterface = new Interface([
  'event ListingCreated(uint256 indexed listingId,address indexed seller,string description,uint256 price)',
  'event ListingUpdated(uint256 indexed listingId,string description,uint256 price)',
])
const escrowInterface = new Interface([
  'event PurchaseFunded(uint256 indexed transactionId,uint256 indexed listingId,address indexed buyer,address seller,uint256 amount)',
  'event DeliveryMarked(uint256 indexed transactionId,address indexed seller)',
  'event PaymentReleased(uint256 indexed transactionId,address indexed seller,uint256 amount)',
])

function makeLog(contractInterface, eventName, args, { blockNumber, index, nonce = 1 }) {
  const encoded = contractInterface.encodeEventLog(contractInterface.getEvent(eventName), args)
  return {
    ...encoded,
    blockNumber,
    index,
    transactionHash: `0x${nonce.toString(16).padStart(64, '0')}`,
  }
}

function createFixture({ logs = [], latestBlock = 12, failLogs = false } = {}) {
  const database = openDatabase(':memory:')
  const requests = []
  const provider = {
    latestBlock,
    failLogs,
    async getBlockNumber() {
      return this.latestBlock
    },
    async getLogs(filter) {
      requests.push(filter)
      if (this.failLogs) throw new Error('RPC temporarily unavailable')
      return logs.filter((log) =>
        log.address.toLowerCase() === filter.address.toLowerCase() &&
        log.blockNumber >= filter.fromBlock &&
        log.blockNumber <= filter.toBlock,
      )
    },
  }
  function indexer(targetDeploymentId = deploymentId, targetContracts = [
    { name: 'marketplace', address: marketplaceAddress, interface: marketplaceInterface },
    { name: 'escrow', address: escrowAddress, interface: escrowInterface },
  ]) {
    return createEventIndexer({
      database,
      provider,
      chainId: 31337,
      deploymentId: targetDeploymentId,
      contracts: targetContracts,
      startBlock: 2,
      batchSize: 5,
    })
  }
  return { database, provider, requests, indexer }
}

test('indexes actual event data once and resumes incrementally after indexer recreation', async () => {
  const log = makeLog(
    escrowInterface,
    'PurchaseFunded',
    [5n, 42n, buyer, seller, 625n],
    { blockNumber: 3, index: 0 },
  )
  const fundedLog = { ...log, address: escrowAddress }
  const fixture = createFixture({ logs: [fundedLog] })
  try {
    const first = await fixture.indexer().syncOnce()
    assert.equal(first.insertedEvents, 1)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM indexed_events').get().count, 1)

    const restarted = await fixture.indexer().syncOnce()
    assert.equal(restarted.insertedEvents, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM indexed_events').get().count, 1)

    fixture.provider.latestBlock = 14
    const later = makeLog(
      escrowInterface,
      'PaymentReleased',
      [5n, seller, 625n],
      { blockNumber: 14, index: 1, nonce: 2 },
    )
    fixture.provider.getLogs = async (filter) => {
      fixture.requests.push(filter)
      return [fundedLog, { ...later, address: escrowAddress }].filter((entry) =>
        entry.address.toLowerCase() === filter.address.toLowerCase() &&
        entry.blockNumber >= filter.fromBlock &&
        entry.blockNumber <= filter.toBlock,
      )
    }
    const incremental = await fixture.indexer().syncOnce()
    assert.equal(incremental.insertedEvents, 1)
    assert.ok(fixture.requests.some((request) => request.fromBlock === 13))
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM indexed_events').get().count, 2)
    assert.equal(
      fixture.database.prepare('SELECT args_json AS args FROM indexed_events WHERE event_name = ?')
        .get('PurchaseFunded').args.includes(buyer),
      true,
    )
  } finally {
    fixture.database.close()
  }
})

test('scopes event identity and cursors by chain deployment and contract', async () => {
  const listingLog = makeLog(
    marketplaceInterface,
    'ListingCreated',
    [1n, seller, 'A demo listing', 10n],
    { blockNumber: 2, index: 0 },
  )
  const fixture = createFixture({ logs: [{ ...listingLog, address: marketplaceAddress }] })
  try {
    assert.equal((await fixture.indexer().syncOnce()).insertedEvents, 1)
    assert.equal((await fixture.indexer(alternateDeploymentId).syncOnce()).insertedEvents, 1)
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM indexed_events').get().count,
      2,
    )
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM indexer_cursors').get().count,
      4,
    )
  } finally {
    fixture.database.close()
  }
})

test('leaves cursors unchanged on temporary RPC failure and retries successfully', async () => {
  const fixture = createFixture({ failLogs: true })
  try {
    await assert.rejects(fixture.indexer().syncOnce(), /RPC temporarily unavailable/)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM indexer_cursors').get().count, 0)
    fixture.provider.failLogs = false
    assert.equal((await fixture.indexer().syncOnce()).latestBlock, 12)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM indexer_cursors').get().count, 2)
  } finally {
    fixture.database.close()
  }
})

test('does not advance the event cursor when an RPC log is incomplete', async () => {
  const good = makeLog(
    escrowInterface,
    'DeliveryMarked',
    [5n, seller],
    { blockNumber: 4, index: 0 },
  )
  const fixture = createFixture({
    logs: [{ ...good, address: escrowAddress, index: undefined }],
  })
  try {
    await assert.rejects(fixture.indexer().syncOnce(), /Incomplete DeliveryMarked log/)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM indexed_events').get().count, 0)
    assert.equal(
      fixture.database.prepare('SELECT COUNT(*) AS count FROM indexer_cursors WHERE contract_address = ?')
        .get(escrowAddress).count,
      0,
    )
  } finally {
    fixture.database.close()
  }
})
