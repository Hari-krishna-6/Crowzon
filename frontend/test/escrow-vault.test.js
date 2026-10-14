import assert from 'node:assert/strict'
import test from 'node:test'
import { summarizeEscrowVault } from '../src/escrow-vault.js'

test('counts only funded, delivered, and disputed escrows as active liabilities', () => {
  const summary = summarizeEscrowVault([
    { status: 0, amount: 2n },
    { status: 1, amount: 3n },
    { status: 2, amount: 5n },
    { status: 3, amount: 7n },
    { status: 4, amount: 11n },
  ])
  assert.deepEqual(summary, { activeCount: 3, activeLiabilities: 10n })
})

test('summarizes an empty escrow history', () => {
  assert.deepEqual(
    summarizeEscrowVault([]),
    { activeCount: 0, activeLiabilities: 0n },
  )
})
