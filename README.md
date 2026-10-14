# Crowzon

**Crowzon — Decentralized P2P Marketplace with Smart Contract Escrow**  
**Trade Directly. Trust the Blockchain.**

Crowzon is a college course project for direct buyer-to-seller trading. It is
designed to use Solidity contracts on a local Hardhat blockchain. Its users and
token balances are simulated for demonstration and testing; the project does
not process real payments or use real cryptocurrency.

## Project layout

- `frontend/` — React application built with Vite.
- `blockchain/` — Hardhat project for Solidity contracts, local deployment, and
  contract tests.
- `backend/` — Express REST API and persistent SQLite storage for off-chain
  profiles and listing metadata. Blockchain payment and escrow state remains
  exclusively in the Solidity contracts.

## Development prerequisites

- Node.js 24 or a compatible supported release.
- npm.

## Getting started

Install each workspace's dependencies:

```powershell
cd frontend
npm install
cd ..\blockchain
npm install
```

Each workspace has its own `package.json`; there is intentionally no root
`package.json`. Run npm commands from the relevant workspace directory. For
example, `npm.cmd run node` from the project root fails because npm cannot find a
root manifest.

## Windows local demo

Use separate PowerShell terminals. The Hardhat node is an in-memory chain:
stopping it loses its listings, balances, and escrow history. Keep it running
for the duration of a demo, and do not deploy again when its existing
deployment is valid.

### Terminal 1: check before starting the node

From any directory, check whether port 8545 is listening:

```powershell
Get-NetTCPConnection -LocalPort 8545 -State Listen -ErrorAction SilentlyContinue
```

If a listener is returned, query its chain ID rather than starting another node:

```powershell
$body = '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
Invoke-RestMethod -Uri 'http://127.0.0.1:8545' -Method Post `
  -ContentType 'application/json' -Body $body
```

The expected result is `0x7a69` (decimal chain ID `31337`). If the port has no
listener, start the node in this terminal:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\blockchain'
npm.cmd run node
```

Leave this terminal running. If port 8545 is occupied but does not answer as
expected, investigate the listener; do not start another node on that port.

### Before deploying: preserve an existing deployment

In another terminal, inspect the deployment artifact and confirm the RPC still
reports chain ID 31337. The frontend uses
`blockchain\deployments\localhost.json`; its recorded addresses must have
contract bytecode on the current node. Do **not** run deployment as a routine
startup step: `deploy:local` overwrites this artifact and deploys new contracts.

Only after intentionally starting a fresh node (or intentionally recreating the
deployment), deploy from the blockchain directory:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\blockchain'
npm.cmd run deploy:local
npm.cmd run verify:local
```

The verification command submits local demo transactions. Run it only when you
intend to create that verification history. Never use a public network or real
funds.

### Terminal 2: start the frontend

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\frontend'
npm.cmd run dev -- --host 127.0.0.1
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/). Confirm the page reports
“Connected to local Hardhat” and “Chain 31337”. The frontend proxies RPC
requests to `http://127.0.0.1:8545`; it reads addresses from the deployment
artifact and ABIs from generated Hardhat artifacts.

Run blockchain commands such as `npm.cmd run compile`, `npm.cmd test`,
`npm.cmd run deploy:local`, and `npm.cmd run verify:local` from
`G:\Projects\P2P_Crowzon\blockchain`. Run `npm.cmd run build`, `npm.cmd run lint`,
and `npm.cmd run dev -- --host 127.0.0.1` from
`G:\Projects\P2P_Crowzon\frontend`.

If the node is stopped or reset, its in-memory state is lost. Start a fresh node,
deploy again intentionally, then recreate showcase listings through the
frontend. Restart Vite after redeployment so it reads the refreshed deployment
artifact. Do not stop or restart the node to troubleshoot the frontend.

Use only local development accounts and the local Hardhat chain for this
course-project demo. Never put development private keys or `.env` files into
source control, and do not connect this project to a public network or real
funds.

## Backend API

From a separate PowerShell terminal:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\backend'
npm.cmd install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run db:init
npm.cmd test
npm.cmd start
```

The API defaults to `http://127.0.0.1:3000`; check `GET /api/health`. SQLite is
stored in `backend/data/crowzon.sqlite` by default and is ignored by Git. Set
`PORT` or `SQLITE_PATH` in `backend/.env` to override the defaults. Register or
sign in in the frontend to create or manage off-chain listing metadata. The API
uses password hashes and HttpOnly session cookies; authenticated users can
modify only metadata they own. Public product/profile reads remain available.
The frontend proxies `/api` to the backend and scopes metadata by
`(deploymentId, chainId, marketplaceAddress, listingId)`. On-chain ownership,
price, listing state, CVT, and escrow remain contract-authoritative. A Crowzon
login does not verify the selected local wallet or authorize its blockchain
actions; wallet association is unverified profile data. On startup the backend
also reads and indexes marketplace/escrow events from the local deployment
artifact and ABIs using a read-only provider (`RPC_URL`, default
`http://127.0.0.1:8545`). The Activity view can display persistent indexed
receipts; current escrow states continue to come from the contract. Orders API
queries require sign-in and an explicit session profile address association.
The address is not verified and is never accepted as proof of ownership.
