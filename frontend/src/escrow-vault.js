export const ESCROW_ACTIVE_STATUSES = new Set([0, 1, 2])

export function summarizeEscrowVault(transactions) {
  return transactions.reduce(
    (summary, transaction) => {
      if (ESCROW_ACTIVE_STATUSES.has(transaction.status)) {
        summary.activeCount += 1
        summary.activeLiabilities += transaction.amount
      }
      return summary
    },
    { activeCount: 0, activeLiabilities: 0n },
  )
}
