/// <reference types="vite/client" />

declare module 'virtual:crowzon-contracts' {
  export const deployment: {
    network: string
    localOnly: boolean
    chainId: string
    paymentCurrency: string
    deploymentId: string
    marketplace: string
    escrow: string
    accounts: {
      deployer: string
      buyer: string
      seller: string
      disputeResolver: string
      additionalDevelopmentAccounts: string[]
    }
  }
  export const marketplaceAbi: readonly unknown[]
  export const escrowAbi: readonly unknown[]
}
