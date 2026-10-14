function jsonValue(value) {
  if (typeof value === 'bigint') return value.toString()
  if (Array.isArray(value)) return value.map(jsonValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]))
  }
  return value
}

function eventArguments(parsed) {
  return Object.fromEntries(
    parsed.fragment.inputs.map((input, index) => [
      input.name || String(index),
      jsonValue(parsed.args[index]),
    ]),
  )
}

function indexedFields(contractName, eventName, args) {
  const listingId = args.listingId ?? null
  const transactionId = args.transactionId ?? null
  const buyerAddress = args.buyer ?? null
  const sellerAddress = args.seller ?? null
  const actorAddress =
    args.buyer ??
    args.seller ??
    args.raisedBy ??
    args.resolver ??
    null

  return {
    contractName,
    eventName,
    listingId: listingId === null ? null : String(listingId),
    transactionId: transactionId === null ? null : String(transactionId),
    buyerAddress,
    sellerAddress,
    actorAddress,
  }
}

export function createEventIndexer({
  database,
  provider,
  chainId,
  deploymentId,
  contracts,
  startBlock,
  batchSize = 2000,
}) {
  if (!Number.isSafeInteger(chainId) || chainId !== 31337) {
    throw new Error('Event indexer only supports the local Hardhat chain 31337.')
  }
  if (!deploymentId || !Array.isArray(contracts) || contracts.length === 0) {
    throw new Error('Event indexer requires a deployment ID and contract ABIs.')
  }
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) {
    throw new Error('Event indexer requires a valid deployment start block.')
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('Event indexer batch size must be a positive integer.')
  }

  let syncing = false
  const normalizedContracts = contracts.map((contract) => ({
    ...contract,
    address: contract.address.toLowerCase(),
  }))
  const cursorQuery = database.prepare(`
    SELECT cursor_block AS cursorBlock
    FROM indexer_cursors
    WHERE chain_id = ? AND deployment_id = ? AND contract_address = ?
  `)
  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO indexed_events (
      chain_id, deployment_id, contract_name, contract_address,
      transaction_hash, log_index, block_number, event_name, listing_id,
      transaction_id, buyer_address, seller_address, actor_address, args_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const updateCursor = database.prepare(`
    INSERT INTO indexer_cursors (
      chain_id, deployment_id, contract_address, contract_name, cursor_block
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(chain_id, deployment_id, contract_address) DO UPDATE SET
      cursor_block = excluded.cursor_block,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `)

  async function syncOnce() {
    if (syncing) return { skipped: true, reason: 'sync already in progress' }
    syncing = true
    try {
      const latestBlock = await provider.getBlockNumber()
      let insertedEvents = 0

      for (const contract of normalizedContracts) {
        const savedCursor = cursorQuery.get(chainId, deploymentId, contract.address)
        let cursor = savedCursor ? Number(savedCursor.cursorBlock) : startBlock - 1
        while (cursor < latestBlock) {
          const fromBlock = cursor + 1
          const toBlock = Math.min(latestBlock, fromBlock + batchSize - 1)
          const logs = await provider.getLogs({
            address: contract.address,
            fromBlock,
            toBlock,
          })
          const rows = []
          for (const log of logs) {
            const parsed = contract.interface.parseLog(log)
            if (!parsed) continue
            const args = eventArguments(parsed)
            const fields = indexedFields(contract.name, parsed.name, args)
            const logIndex = log.index ?? log.logIndex
            if (
              typeof log.transactionHash !== 'string' ||
              !Number.isSafeInteger(Number(logIndex)) ||
              !Number.isSafeInteger(Number(log.blockNumber))
            ) {
              throw new Error(`Incomplete ${parsed.name} log returned by the local RPC.`)
            }
            rows.push([
              chainId,
              deploymentId,
              fields.contractName,
              contract.address,
              log.transactionHash,
              Number(logIndex),
              Number(log.blockNumber),
              fields.eventName,
              fields.listingId,
              fields.transactionId,
              fields.buyerAddress,
              fields.sellerAddress,
              fields.actorAddress,
              JSON.stringify(args),
            ])
          }

          database.exec('BEGIN IMMEDIATE')
          try {
            for (const row of rows) insertedEvents += Number(insertEvent.run(...row).changes)
            updateCursor.run(chainId, deploymentId, contract.address, contract.name, toBlock)
            database.exec('COMMIT')
          } catch (error) {
            database.exec('ROLLBACK')
            throw error
          }
          cursor = toBlock
        }
      }

      return { skipped: false, latestBlock, insertedEvents }
    } finally {
      syncing = false
    }
  }

  return { syncOnce }
}
