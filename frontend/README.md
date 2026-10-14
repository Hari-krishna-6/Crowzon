# Crowzon frontend

React/Vite interface for the local Crowzon smart-contract demo. It reads
deployed addresses from `../blockchain/deployments/localhost.json` and the
generated Hardhat ABI files in `../blockchain/artifacts/`; do not duplicate
contract addresses or commit development keys in frontend code.

## Start the demo

Keep the local Hardhat node running, with contracts deployed and the deployment
artifact generated. Then, from this directory:

```powershell
npm install
npm run dev
```

The Vite development and preview servers proxy `/rpc` to the local Hardhat
endpoint at `http://127.0.0.1:8545`, avoiding cross-origin browser requests.
The app verifies chain ID `31337`, bytecode at all three configured addresses,
and only enables actions against that deployment. This proxy is for local
development only; do not expose it publicly.

The deployment addresses and ABIs are read from the blockchain workspace when
Vite starts or builds. After resetting the local chain and redeploying, restart
the dev server or rebuild the frontend so it picks up the refreshed deployment
artifact.

Use the account selector to choose an unlocked Hardhat development account.
These accounts are simulated and their keys are intentionally not included in
the frontend. CVT is simulated demo money with no real-world monetary value.
Category and illustration styling is local presentation metadata; listing
descriptions, owners, prices, escrow states, balances, and event history come
from contracts and local-chain receipts.

The Vite development server proxies `/api` to the Express backend at
`http://127.0.0.1:3000`. Product metadata is matched using the tuple
`(deploymentId, chainId, marketplaceAddress, listingId)`; the contract remains authoritative
for listing ownership, price, and active state. Existing contract listings stay
visible when metadata is absent or the API is unavailable. A newly created
contract listing is recorded in SQLite only after its chain receipt confirms;
creating an API product record never creates a blockchain listing.

Seller profiles, categories, and optional image references are off-chain.
Register or sign in through the frontend to create or manage listing metadata;
the backend assigns ownership from the authenticated session. The selected
local wallet remains a separate, unverified identity and is not proof of
ownership. Seller Studio supports additional off-chain product details and
validated HTTP(S)/relative image references; it does not upload image files.
In Activity, explicitly associate the selected development address to query
public indexed history; this is unverified and does not assert wallet
ownership. The view may show persistent indexed escrow receipts when the
backend indexer has caught up. Event data is not treated as current escrow
status; displayed status is independently read from the deployed contract.
Keep the backend on the local development machine.

Run `npm run test`, `npm run lint`, and `npm run build` to validate the frontend.
