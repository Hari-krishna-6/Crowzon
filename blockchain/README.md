# Crowzon blockchain

This workspace contains the Solidity contracts and Hardhat tests for the
Crowzon course-project marketplace. It uses a local Hardhat blockchain and
simulated CVT balances only. CVT is not real cryptocurrency and has no intended
real-world monetary value.

## Contracts

- `CrowzonToken` is a fixed-supply ERC-20 with 1,000,000 CVT total. It allocates
  10,000 CVT to each development account supplied at construction and mints the
  remaining supply to the deployer. It has no owner, post-deployment minting
  role, or special transfer privileges.
- `CrowzonMarketplace` lets sellers create, update, and deactivate listings.
  Buyers purchase active listings; self-purchases and inactive listings are
  rejected. A listing remains available for multiple purchases until its seller
  deactivates it.
- `CrowzonEscrow` holds the buyer's approved CVT and tracks each purchase as
  `FUNDED`, `DELIVERED`, `DISPUTED`, `COMPLETED`, or `REFUNDED`. The marketplace
  deploys one escrow contract and is its only purchase-creation authority.

## Permissions and lifecycle

- A seller controls updates and deactivation of their own listings.
- A buyer approves the **escrow contract address** to spend CVT, then calls
  `buyListing` on the marketplace. The marketplace creates the purchase and
  the escrow transfers the approved CVT directly from that buyer.
- Only the seller can mark their funded purchase delivered. Only its buyer can
  confirm delivery and release funds.
- Either party can raise a dispute from `FUNDED` or `DELIVERED` before the
  associated deadline. Only the immutable dispute resolver selected when the
  marketplace is deployed can resolve a dispute, choosing release to the seller
  or refund to the buyer.
- There is no owner or administrator with a general withdrawal or seizure
  function. The resolver can act only on disputed purchases and only choose
  between the two recorded parties.
- The buyer can cancel while a purchase is still `FUNDED`. If the seller does
  not mark delivery within **7 days** of funding, anyone can trigger a refund to
  the buyer. If the seller marks delivery and the buyer neither confirms nor
  disputes it within **7 days**, anyone can finalize payment to the seller.
- An unresolved dispute is automatically refundable to the buyer after **30
  days** from the dispute. Anyone may trigger that fixed timeout outcome. This
  conservative default prevents the resolver's inactivity from locking funds
  indefinitely.
- All settlement changes state before token transfers and use OpenZeppelin
  `SafeERC20` and `ReentrancyGuard`.

## Install, compile, and test

From this directory:

```powershell
npm install
npm run compile
npm test
```

The test suite deploys the actual contracts to Hardhat's in-process local
development blockchain. It does not mock Solidity contract behavior. A
test-only callback token exercises the escrow's reentrancy guard.

## Local deployment

In one terminal, run `npm run node`. In another, run `npm run deploy:local`.
The deployment script refuses a chain ID other than Hardhat's local 31337,
allocates CVT to simulated development accounts, and records contract and role
addresses in the ignored `deployments/localhost.json` file. It does not record
or expose private keys.

With that node still running and after deployment, run `npm run verify:local`
to exercise an on-chain listing, approval, purchase, delivery, release, and
rejected unauthorized confirmation. Transaction hashes, block numbers, events,
and final state are recorded in the ignored
`deployments/verification-local.json` file.

If the local node is stopped, its in-memory chain state is reset. Start a new
node with `npm run node`, then redeploy with `npm run deploy:local` and repeat
`npm run verify:local`. The deployment script refreshes the localhost address
artifact for the new chain.
