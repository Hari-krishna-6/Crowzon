import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getSellerStudioListings,
  ownsListingMetadata,
} from '../src/seller-ownership.js'

const deployment = {
  chainId: 31337,
  marketplaceAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  deploymentId: 'deployment-current',
}
const assignedSeller = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const otherSeller = '0xcccccccccccccccccccccccccccccccccccccccc'
const chainListings = [
  { id: 1n, seller: assignedSeller, description: 'Owned by backend user 1' },
  { id: 2n, seller: otherSeller, description: 'Owned by backend user 2' },
]
const products = [
  { id: 1, sellerId: 1, listingId: 1, ...deployment },
  { id: 2, sellerId: 2, listingId: 2, ...deployment },
]

test('public listings remain available while Seller Studio isolates backend owners', () => {
  assert.equal(chainListings.length, 2)
  const firstOwner = getSellerStudioListings(chainListings, products, 1, assignedSeller, deployment)
  const secondOwner = getSellerStudioListings(chainListings, products, 2, otherSeller, deployment)
  assert.deepEqual(firstOwner.map((listing) => String(listing.id)), ['1'])
  assert.deepEqual(secondOwner.map((listing) => String(listing.id)), ['2'])
  assert.equal(firstOwner[0].chainManageable, true)
  assert.equal(secondOwner[0].chainManageable, true)
})

test('a matching Hardhat address cannot make another user’s listing appear owned', () => {
  const newUser = getSellerStudioListings(chainListings, products, 3, otherSeller, deployment)
  assert.deepEqual(newUser, [])
  assert.equal(ownsListingMetadata(products, 2, 3, deployment), false)
})

test('a legacy backend-owner and chain-seller mismatch is visible but not mutable', () => {
  const existingOwner = getSellerStudioListings(chainListings, products, 1, otherSeller, deployment)
  assert.equal(existingOwner.length, 1)
  assert.equal(existingOwner[0].chainManageable, false)
})
