# Crowzon

**Crowzon — Decentralized P2P Marketplace with Smart Contract Escrow**  
**Trade Directly. Trust the Blockchain.**

Crowzon is a college course project for direct buyer-to-seller trading. It uses
Solidity contracts deployed to a local Hardhat blockchain. Users and ETH are
simulated for demonstration: this project does not process real payments, use
real cryptocurrency, or connect to a public blockchain.

For the complete implementation-level technical report, see
[TECHNICAL_DOCUMENTATION.md](./TECHNICAL_DOCUMENTATION.md).

## Features

- Browse on-chain marketplace listings, search, and filter by category.
- Register and sign in with a Crowzon email/password account.
- Assign each registered user a distinct account from the local Hardhat
  account pool; the assignment persists across sessions. The pool supports up
  to ten users.
- Purchase listings with simulated local ETH held in contract escrow.
- Use Buyer Desk and Seller Studio for separate buyer and seller workflows.
  Seller Studio shows listings linked to the authenticated Crowzon profile;
  backend ownership and on-chain seller identity are checked independently.
- Review transaction history in Activity and inspect live escrow records,
  contract balance, and statuses in Escrow Vault.
- Store off-chain profiles and listing details in the backend; listing
  ownership, prices, payments, and escrow state remain contract-authoritative.

## Project layout

- `frontend/` — React application built with Vite.
- `blockchain/` — Hardhat project, Solidity contracts, deployment scripts, and
  contract tests.
- `backend/` — Express API, authentication, event indexing, and persistent
  SQLite storage for off-chain data.

Each workspace has its own `package.json`; run npm commands from that workspace.
There is no root package manifest.

## Prerequisites and installation

Use Node.js 24 (or a compatible supported release) and npm. In PowerShell,
install dependencies in each workspace:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\blockchain'
npm.cmd install

Set-Location 'G:\Projects\P2P_Crowzon\backend'
npm.cmd install

Set-Location 'G:\Projects\P2P_Crowzon\frontend'
npm.cmd install
```

## Run the local application on Windows

The Hardhat node is an in-memory chain. Stopping or resetting it loses its
listings, balances, and escrow history. Keep an existing node running and do
not redeploy if its native-ETH deployment is valid.

### 1. Check or start the Hardhat node

Check whether port 8545 already has a listener:

```powershell
Get-NetTCPConnection -LocalPort 8545 -State Listen -ErrorAction SilentlyContinue
```

If it is listening, check the chain ID before proceeding:

```powershell
$body = '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}'
Invoke-RestMethod -Uri 'http://127.0.0.1:8545' -Method Post `
  -ContentType 'application/json' -Body $body
```

The expected chain ID is `0x7a69` (decimal `31337`). If no listener exists,
start the local node in this terminal and leave it running:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\blockchain'
npm.cmd run node
```

Do not start a second node if port 8545 is already occupied.

### 2. Confirm the native-ETH deployment

The application reads contract addresses from
`blockchain\deployments\localhost-native-eth.json`. Before deploying, confirm
that the artifact matches the running chain and that its addresses contain
contract bytecode. The legacy CVT deployment in
`blockchain\deployments\localhost.json` is separate and must not be treated as
the native-ETH deployment.

Deployment is not a routine startup step. Only when intentionally deploying to
a fresh local node, run from the blockchain workspace:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\blockchain'
npm.cmd run deploy:native-eth -- --network localhost
```

This writes the separate native-ETH artifact after deployment verification.
Never use a public network or real funds.

### 3. Start the backend

In a separate terminal:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\backend'
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run db:init
npm.cmd start
```

The API defaults to `http://127.0.0.1:3000`; `GET /api/health` reports its
status. SQLite data is stored in `backend\data\crowzon.sqlite` by default and
is ignored by Git. The backend connects to the local RPC at
`http://127.0.0.1:8545` to validate account assignments and index contract
events. See [backend documentation](backend/README.md) for configuration and
API details.

### 4. Start the frontend

In another terminal:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\frontend'
npm.cmd run dev -- --host 127.0.0.1
```

Open [http://127.0.0.1:5173/](http://127.0.0.1:5173/). Vite proxies `/api` to
the backend and `/rpc` to the local Hardhat node. Restart Vite after an
intentional deployment so it reloads the deployment artifact and generated
contract ABIs.

## Authentication and local accounts

Crowzon authentication is separate from blockchain identity. Sign in or
register through the frontend; the backend assigns the authenticated user one
of the ten accounts returned by the local Hardhat RPC and persists that
assignment. Existing users retain their assignments across login and logout.
Registration is rejected if the account pool is full or unavailable. The
frontend does not contain development private keys.

Seller Studio uses authenticated backend listing ownership for its list and
checks that the assigned account also matches the on-chain seller before
allowing contract management. Older listings whose backend owner and on-chain
seller differ are not silently reassigned; management is disabled for those
records. This local account assignment is not protection against someone with
direct access to the development RPC, whose unlocked accounts can submit
transactions independently of the web application.

## Checks

Run tests and builds from the applicable workspace:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\blockchain'
npm.cmd test

Set-Location 'G:\Projects\P2P_Crowzon\backend'
npm.cmd test

Set-Location 'G:\Projects\P2P_Crowzon\frontend'
npm.cmd test
npm.cmd run lint
npm.cmd run build
```

## Safety

This project is for a local course demonstration only. Local ETH is simulated
and has no intended real-world value. Do not connect to a public network, use
real funds, commit `.env` files, or add private keys to source code. The
Hardhat node and Vite RPC proxy must remain local and must not be exposed as
public services.
