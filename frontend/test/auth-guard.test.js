import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AuthenticationRequiredError,
  getAssignedBlockchainAccount,
  withAuthenticatedSession,
} from '../src/auth-guard.js'

test('signed-out purchase attempt does not start a blockchain action', async () => {
  let purchaseStarted = false
  await assert.rejects(
    withAuthenticatedSession(
      async () => { throw Object.assign(new Error('Sign in required.'), { status: 401 }) },
      async () => { purchaseStarted = true },
    ),
    AuthenticationRequiredError,
  )
  assert.equal(purchaseStarted, false)
})

test('signed-out listing creation does not start a blockchain action', async () => {
  let listingStarted = false
  await assert.rejects(
    withAuthenticatedSession(
      async () => { throw Object.assign(new Error('Sign in required.'), { status: 401 }) },
      async () => { listingStarted = true },
    ),
    AuthenticationRequiredError,
  )
  assert.equal(listingStarted, false)
})

test('rejects invalid or expired session responses before protected actions', async () => {
  let actionStarted = false
  await assert.rejects(
    withAuthenticatedSession(async () => null, async () => { actionStarted = true }),
    AuthenticationRequiredError,
  )
  assert.equal(actionStarted, false)
})

test('runs protected actions for a valid backend session', async () => {
  const user = { id: 12, displayName: 'Signed-in seller' }
  const result = await withAuthenticatedSession(
    async () => user,
    async (sessionUser) => `created for ${sessionUser.id}`,
  )
  assert.equal(result, 'created for 12')
})

test('selects distinct buyer and seller accounts only from their authenticated assignments', () => {
  const buyerAccount = `0x${'a'.repeat(40)}`
  const sellerAccount = `0x${'b'.repeat(40)}`
  const available = [sellerAccount, buyerAccount]
  assert.equal(
    getAssignedBlockchainAccount({ assignedAccount: buyerAccount }, available),
    buyerAccount,
  )
  assert.equal(
    getAssignedBlockchainAccount({ assignedAccount: sellerAccount }, available),
    sellerAccount,
  )
  assert.throws(
    () => getAssignedBlockchainAccount({ assignedAccount: buyerAccount }, [sellerAccount]),
    /No other account will be selected/,
  )
})
