import dotenv from 'dotenv'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Contract, Interface, JsonRpcProvider } from 'ethers'
import { createApp } from './app.js'
import { resolveDatabasePath, resolveDatabaseDriver } from './database.js'
import { createEventIndexer } from './event-indexer.js'
import { assertPostgresConnection, openPostgresDatabase, resolvePostgresConfig, runPostgresMigrations } from './postgres.js'

const backendDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
dotenv.config({ path: path.join(backendDirectory, '.env') })

const port = Number(process.env.PORT ?? 3000)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.')
}
const databaseDriver = resolveDatabaseDriver(process.env)
let databasePath = null
let database = null
if (databaseDriver === 'postgres') {
  const postgresConfig = resolvePostgresConfig(process.env)
  await assertPostgresConnection(postgresConfig)
  await runPostgresMigrations(process.env)
  database = openPostgresDatabase(postgresConfig.databaseUrl, { application_name: postgresConfig.applicationName })
  console.log('Using PostgreSQL for Crowzon persistence.')
} else {
  databasePath = resolveDatabasePath(process.env.SQLITE_PATH, backendDirectory)
  console.log(`SQLite database: ${databasePath}`)
}
const blockchainDirectory = path.resolve(backendDirectory, '..', 'blockchain')
const nativeDeploymentPath = path.join(blockchainDirectory, 'deployments', 'localhost-native-eth.json')
const nativeMarketplaceArtifactPath = path.join(
  blockchainDirectory,
  'artifacts',
  'contracts',
  'CrowzonMarketplace.sol',
  'CrowzonMarketplace.json',
)
const [nativeDeployment, nativeMarketplaceArtifact] = await Promise.all([
  readFile(nativeDeploymentPath, 'utf8').then(JSON.parse),
  readFile(nativeMarketplaceArtifactPath, 'utf8').then(JSON.parse),
])
const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'http://127.0.0.1:8545')
const nativeMarketplace = new Contract(nativeDeployment.marketplace, nativeMarketplaceArtifact.abi, provider)
const app = createApp({
  databasePath,
  database,
  getDevelopmentAccounts: async () => {
    const network = await provider.getNetwork()
    if (network.chainId !== 31337n) {
      throw new Error(`Expected local Hardhat chain 31337, received ${network.chainId}.`)
    }
    const accounts = await provider.send('eth_accounts', [])
    return accounts.slice(0, 10)
  },
  getListingSeller: async ({ listingId, chainId, marketplaceAddress, deploymentId }) => {
    const network = await provider.getNetwork()
    if (
      network.chainId !== 31337n ||
      Number(chainId) !== 31337 ||
      marketplaceAddress?.toLowerCase() !== nativeDeployment.marketplace.toLowerCase() ||
      deploymentId?.toLowerCase() !== nativeDeployment.deploymentId.toLowerCase()
    ) {
      throw new Error('Listing metadata does not target the active native-ETH deployment.')
    }
    const listing = await nativeMarketplace.getListing(listingId)
    return listing.seller
  },
})
try {
  const { users } = await app.locals.reconcileAccountAssignments()
  console.log(`Validated blockchain account assignments for ${users.length} user(s).`)
} catch (error) {
  console.error(`Blockchain account assignment migration is pending: ${error.message}`)
}
const deploymentPath = path.join(blockchainDirectory, 'deployments', 'localhost.json')
const marketplaceArtifactPath = path.join(
  blockchainDirectory,
  'artifacts',
  'contracts',
  'CrowzonMarketplace.sol',
  'CrowzonMarketplace.json',
)
const escrowArtifactPath = path.join(
  blockchainDirectory,
  'artifacts',
  'contracts',
  'CrowzonEscrow.sol',
  'CrowzonEscrow.json',
)
const [deployment, marketplaceArtifact, escrowArtifact] = await Promise.all([
  readFile(deploymentPath, 'utf8').then(JSON.parse),
  readFile(marketplaceArtifactPath, 'utf8').then(JSON.parse),
  readFile(escrowArtifactPath, 'utf8').then(JSON.parse),
])
if (deployment.localOnly !== true || deployment.chainId !== '31337') {
  throw new Error('Event indexer refuses a deployment other than local chain 31337.')
}
const indexer = createEventIndexer({
  database: app.locals.database,
  provider,
  chainId: Number(deployment.chainId),
  deploymentId: deployment.deploymentId,
  startBlock: Number(deployment.deploymentTransactions.marketplaceAndEscrow.blockNumber),
  contracts: [
    {
      name: 'marketplace',
      address: deployment.marketplace,
      interface: new Interface(marketplaceArtifact.abi),
    },
    {
      name: 'escrow',
      address: deployment.escrow,
      interface: new Interface(escrowArtifact.abi),
    },
  ],
})
const server = app.listen(port, '127.0.0.1', () => {
  console.log(`Crowzon API listening at http://127.0.0.1:${port}`)
  if (databasePath) {
    console.log(`SQLite database: ${databasePath}`)
  } else {
    console.log('PostgreSQL persistence configured.')
  }
})

async function syncEvents() {
  try {
    const network = await provider.getNetwork()
    if (network.chainId !== 31337n) {
      throw new Error(`Refusing to index unexpected chain ID ${network.chainId}.`)
    }
    const result = await indexer.syncOnce()
    if (result.insertedEvents) {
      console.log(`Indexed ${result.insertedEvents} local contract event(s) through block ${result.latestBlock}.`)
    }
  } catch (error) {
    console.error(`Blockchain event indexing failed; will retry: ${error.message}`)
  }
}

const indexerTimer = setInterval(() => { void syncEvents() }, 5000)
indexerTimer.unref()
void syncEvents()

function shutDown() {
  clearInterval(indexerTimer)
  provider.destroy()
  server.close(() => {
    app.locals.closeDatabase()
    process.exit(0)
  })
}

process.on('SIGINT', shutDown)
process.on('SIGTERM', shutDown)
