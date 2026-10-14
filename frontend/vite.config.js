import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const frontendDirectory = path.dirname(fileURLToPath(import.meta.url))
const blockchainDirectory = path.resolve(frontendDirectory, '..', 'blockchain')
const virtualConfigId = 'virtual:crowzon-contracts'
const resolvedVirtualConfigId = `\0${virtualConfigId}`
const DEPLOYMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function crowzonContractConfig() {
  return {
    name: 'crowzon-contract-config',
    resolveId(id) {
      return id === virtualConfigId ? resolvedVirtualConfigId : null
    },
    async load(id) {
      if (id !== resolvedVirtualConfigId) return null

      const deploymentPath = path.join(blockchainDirectory, 'deployments', 'localhost-native-eth.json')
      const deployment = JSON.parse(await readFile(deploymentPath, 'utf8'))
      if (
        deployment.chainId !== '31337' ||
        deployment.localOnly !== true ||
        deployment.paymentCurrency !== 'ETH' ||
        !DEPLOYMENT_ID_PATTERN.test(deployment.deploymentId ?? '')
      ) {
        throw new Error('Crowzon frontend requires the native-ETH localhost deployment on chain 31337.')
      }

      const artifactPaths = {
        marketplace: path.join(
          blockchainDirectory,
          'artifacts',
          'contracts',
          'CrowzonMarketplace.sol',
          'CrowzonMarketplace.json',
        ),
        escrow: path.join(
          blockchainDirectory,
          'artifacts',
          'contracts',
          'CrowzonEscrow.sol',
          'CrowzonEscrow.json',
        ),
      }

      const abis = {}
      for (const [name, artifactPath] of Object.entries(artifactPaths)) {
        const artifact = JSON.parse(await readFile(artifactPath, 'utf8'))
        abis[name] = artifact.abi
      }

      return [
        `export const deployment = ${JSON.stringify(deployment)};`,
        `export const marketplaceAbi = ${JSON.stringify(abis.marketplace)};`,
        `export const escrowAbi = ${JSON.stringify(abis.escrow)};`,
      ].join('\n')
    },
  }
}

const rpcProxy = {
  '/api': {
    target: 'http://127.0.0.1:3000',
    changeOrigin: true,
  },
  '/rpc': {
    target: 'http://127.0.0.1:8545',
    changeOrigin: true,
    rewrite: (requestPath) => requestPath.replace(/^\/rpc$/, '/'),
  },

  // This is a local-only demo proxy for Hardhat's unlocked development node.
  // It must never be exposed by a public production server.
}

export default defineConfig({
  plugins: [react(), crowzonContractConfig()],
  server: { proxy: rpcProxy },
  preview: { proxy: rpcProxy },
})
