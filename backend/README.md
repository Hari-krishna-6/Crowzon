# Crowzon backend

Local Express API for account authentication and persistent **off-chain**
profiles and listing metadata. Passwords are stored as salted scrypt hashes.
Authentication uses opaque random session tokens stored only as SHA-256 hashes
in SQLite and sent in HttpOnly, SameSite=Lax cookies; cookies are Secure when
`NODE_ENV=production`. Sessions expire after seven days and logout revokes the
server-side session. Solidity remains authoritative for marketplace ownership,
CVT transfers, escrow, refunds, disputes, and settlement.

## Install, initialize, test, start

Run these commands from PowerShell:

```powershell
Set-Location 'G:\Projects\P2P_Crowzon\backend'
npm.cmd install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
npm.cmd run db:init
npm.cmd test
npm.cmd start
```

The default API URL is `http://127.0.0.1:3000`; the default persistent database
is `backend/data/crowzon.sqlite`. `PORT` and `SQLITE_PATH` are configurable
through `.env`. Relative database paths resolve from this backend directory.
The SQLite file and its WAL files are ignored by Git.

## Endpoints

- `GET /api/health`
- Authenticated order history: `GET /api/orders?walletAddress=0x...&chainId=31337&deploymentId=<uuid>`
- `POST /api/auth/register`, `POST /api/auth/login`
- `POST /api/auth/logout`, `GET /api/auth/me`, `PUT /api/auth/wallet`
- Public reads: `GET /api/users`, `GET /api/users/:id`, `GET /api/products`,
  `GET /api/products/:id`
- Authenticated writes: `POST /api/products`, `PATCH /api/products/:id`,
  `POST /api/products/:id/deactivate`
- `GET /api/users?walletAddress=0x...` to look up a linked local profile

Registration accepts `displayName`, `email`, and a password between 12 and 128
characters. Email addresses are normalized to lowercase and unique. Product
write requests do not accept a `sellerId`; the backend assigns ownership from
the authenticated session. Only that owner can update or deactivate their
metadata. Product prices are positive decimal CVT amounts (up to 18 fractional
digits); image values are references only, uploads are not implemented.
Metadata deactivation does not deactivate the separate on-chain listing.

For a product explicitly associated with a local marketplace listing, include
`chainId: 31337`, `marketplaceAddress`, `deploymentId`, and `listingId` together
when creating the metadata record. `deploymentId` is a UUID stored in
`blockchain/deployments/localhost.json` and regenerated on an intentional
deployment. This distinguishes fresh Hardhat deployments even when they reuse
the same deterministic contract addresses and listing IDs. The mapping tuple
is unique and can be queried using
`GET /api/products?chainId=31337&marketplaceAddress=0x...&deploymentId=<uuid>`.
These fields link off-chain metadata to an existing listing; product creation
never creates or changes a Solidity listing. The frontend always obtains
listing ID, seller, price, and active state from the contract and falls back to
contract listing content when no metadata row exists or the API is offline.

### Event indexing and order history

The API reads the local-only deployment artifact and generated marketplace and
escrow ABIs. A read-only Ethers provider polls the configured `RPC_URL`
(default `http://127.0.0.1:8545`) every five seconds, scans contract logs in
bounded block ranges, and persists listing and escrow events to SQLite. Event
identity is unique by chain, deployment, transaction hash, and log index;
per-contract cursors make restarts incremental. RPC failures are logged and
retried without advancing the affected cursor. The indexer does not submit
transactions.

`PUT /api/auth/wallet` explicitly associates the selected local development
address with the signed-in profile for history queries. This association is
not cryptographically verified. `GET /api/orders` requires a Crowzon session
and a previously associated address; it derives the address from that session
and does not accept a caller-selected address parameter. The response marks
the association unverified. Blockchain logs are public, so association is not
proof of ownership. The endpoint does not invent order statuses: the frontend
displays current escrow status only when independently read from the Solidity
contract. Missing funding events or an indexer that has not completed its
first scan are reported as incomplete or not yet indexed.

**Wallet limitation:** a local development account selected in the UI is not
cryptographically associated with a Crowzon profile. Wallet addresses remain
unverified profile metadata and are never accepted as proof of identity. The
Crowzon web login authorizes only off-chain metadata; it does not prove
ownership of, or authorize actions on, a Solidity listing. The contracts enforce
their own wallet permissions.

This authentication implementation is intended for the loopback course demo.
Before production use, deploy only behind HTTPS, add login/registration rate
limits and operational session cleanup/monitoring, and review deployment
hardening. No production credentials or session secret are required or
hardcoded; session tokens are generated with cryptographic randomness.
