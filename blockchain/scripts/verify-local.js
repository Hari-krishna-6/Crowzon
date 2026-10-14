import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { network } from "hardhat";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const deploymentDirectory = path.resolve(scriptDirectory, "..", "deployments");
const deploymentPath = path.join(deploymentDirectory, "localhost.json");
const deployment = JSON.parse(await readFile(deploymentPath, "utf8"));
const { ethers } = await network.create();
const chain = await ethers.provider.getNetwork();

if (chain.chainId !== 31337n || deployment.chainId !== "31337") {
  throw new Error(`Expected local chain ID 31337; connected to ${chain.chainId}`);
}

const [deployer, buyer, seller, resolver, other] = await ethers.getSigners();
for (const [role, signer] of [
  ["deployer", deployer],
  ["buyer", buyer],
  ["seller", seller],
  ["disputeResolver", resolver],
]) {
  if ((await signer.getAddress()).toLowerCase() !== deployment.accounts[role].toLowerCase()) {
    throw new Error(`The local ${role} account does not match the deployment artifact`);
  }
}

const contracts = {
  token: deployment.token,
  marketplace: deployment.marketplace,
  escrow: deployment.escrow,
};
for (const [name, address] of Object.entries(contracts)) {
  const bytecode = await ethers.provider.getCode(address);
  if (bytecode === "0x") throw new Error(`${name} has no deployed bytecode at ${address}`);
}

const token = await ethers.getContractAt("CrowzonToken", deployment.token);
const marketplace = await ethers.getContractAt(
  "CrowzonMarketplace",
  deployment.marketplace
);
const escrow = await ethers.getContractAt("CrowzonEscrow", deployment.escrow);

if ((await marketplace.token()).toLowerCase() !== deployment.token.toLowerCase()) {
  throw new Error("Marketplace token address does not match the deployed token");
}
if ((await marketplace.escrow()).toLowerCase() !== deployment.escrow.toLowerCase()) {
  throw new Error("Marketplace escrow address does not match the deployment artifact");
}
if ((await escrow.token()).toLowerCase() !== deployment.token.toLowerCase()) {
  throw new Error("Escrow token address does not match the deployed token");
}
if ((await escrow.marketplace()).toLowerCase() !== deployment.marketplace.toLowerCase()) {
  throw new Error("Escrow marketplace authorization does not match the marketplace");
}
if ((await escrow.disputeResolver()).toLowerCase() !== resolver.address.toLowerCase()) {
  throw new Error("Escrow resolver does not match the configured development account");
}
if ((await token.symbol()) !== "CVT") throw new Error("Unexpected token symbol");
if ((await token.totalSupply()) !== ethers.parseUnits("1000000", 18)) {
  throw new Error("Unexpected token supply");
}

const developmentAllocation = ethers.parseUnits("10000", 18);
for (const account of [
  deployment.accounts.disputeResolver,
  ...deployment.accounts.additionalDevelopmentAccounts,
]) {
  if ((await token.balanceOf(account)) !== developmentAllocation) {
    throw new Error(`Unexpected CVT balance for development account ${account}`);
  }
}
if ((await token.balanceOf(buyer.address)) < ethers.parseUnits("25", 18)) {
  throw new Error("The configured buyer account has insufficient CVT for verification");
}
if ((await token.balanceOf(seller.address)) < developmentAllocation) {
  throw new Error("The configured seller account has less than its initial allocation");
}

const amount = ethers.parseUnits("25", 18);
const listingDescription = `Local verification item ${Date.now()}`;
const evidence = [];

function recordReceipt(label, receipt, contract) {
  const events = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.target.toLowerCase()) continue;
    const parsed = contract.interface.parseLog(log);
    if (parsed) events.push(parsed.name);
  }
  evidence.push({
    operation: label,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    status: Number(receipt.status),
    events,
  });
}

const verificationListingIds = new Set();
const listingLimit = await marketplace.nextListingId();
for (let id = 1n; id < listingLimit; id++) {
  const listing = await marketplace.getListing(id);
  if (listing.description.startsWith("Local verification item ")) {
    verificationListingIds.add(id.toString());
  }
}

const transactionLimit = await escrow.nextTransactionId();
for (let id = 1n; id < transactionLimit; id++) {
  const transaction = await escrow.getTransaction(id);
  if (!verificationListingIds.has(transaction.listingId.toString())) continue;

  let recoveryTx;
  let recoveryLabel;
  if (transaction.status === 0n && transaction.buyer.toLowerCase() === buyer.address.toLowerCase()) {
    recoveryTx = await escrow.connect(buyer).cancelBeforeDelivery(id);
    recoveryLabel = "recover prior verification purchase by cancellation";
  } else if (
    transaction.status === 1n &&
    transaction.buyer.toLowerCase() === buyer.address.toLowerCase()
  ) {
    recoveryTx = await escrow.connect(buyer).confirmDelivery(id);
    recoveryLabel = "recover prior delivered verification purchase";
  }

  if (recoveryTx) {
    recordReceipt(recoveryLabel, await recoveryTx.wait(), escrow);
  }
}

const listingTx = await marketplace
  .connect(seller)
  .createListing(listingDescription, amount);
const listingReceipt = await listingTx.wait();
recordReceipt("seller creates listing", listingReceipt, marketplace);
const listingEvent = listingReceipt.logs
  .filter((log) => log.address.toLowerCase() === deployment.marketplace.toLowerCase())
  .map((log) => marketplace.interface.parseLog(log))
  .find((event) => event?.name === "ListingCreated");
if (!listingEvent) throw new Error("ListingCreated event was not emitted");
const listingId = listingEvent.args.listingId;

const approveTx = await token
  .connect(buyer)
  .approve(deployment.escrow, amount);
const approveReceipt = await approveTx.wait();
recordReceipt("buyer approves escrow", approveReceipt, token);

const transactionId = await escrow.nextTransactionId();
const escrowBalanceBeforePurchase = await token.balanceOf(deployment.escrow);
const purchaseTx = await marketplace.connect(buyer).buyListing(listingId);
const purchaseReceipt = await purchaseTx.wait();
recordReceipt("buyer purchases listing and funds escrow", purchaseReceipt, marketplace);
recordReceipt("escrow records funded purchase", purchaseReceipt, escrow);

const funded = await escrow.getTransaction(transactionId);
if (
  funded.buyer.toLowerCase() !== buyer.address.toLowerCase() ||
  funded.seller.toLowerCase() !== seller.address.toLowerCase() ||
  funded.listingId !== listingId ||
  funded.amount !== amount ||
  funded.status !== 0n
) {
  throw new Error("Funded escrow transaction does not match purchase details");
}
if (
  (await token.balanceOf(deployment.escrow)) !==
  escrowBalanceBeforePurchase + amount
) {
  throw new Error("Escrow token balance did not increase by the purchase amount");
}

const deliveryTx = await escrow.connect(seller).markDelivered(transactionId);
const deliveryReceipt = await deliveryTx.wait();
recordReceipt("seller marks delivery", deliveryReceipt, escrow);

let unauthorizedError;
try {
  await escrow
    .connect(other)
    .confirmDelivery.staticCall(transactionId);
} catch (error) {
  unauthorizedError = error;
}

if (!unauthorizedError) {
  throw new Error("Unauthorized delivery confirmation unexpectedly succeeded");
}
const revertData =
  unauthorizedError.data ??
  unauthorizedError.info?.error?.data ??
  unauthorizedError.error?.data;
const parsedRevert =
  typeof revertData === "string"
    ? escrow.interface.parseError(revertData)
    : revertData?.data
      ? escrow.interface.parseError(revertData.data)
      : null;
if (parsedRevert?.name !== "Unauthorized") {
  throw new Error(
    `Expected Unauthorized custom error, received ${parsedRevert?.name ?? "unknown revert"}`
  );
}
if ((await escrow.getTransaction(transactionId)).status !== 1n) {
  throw new Error("Unauthorized call changed the escrow transaction state");
}

const sellerBalanceBefore = await token.balanceOf(seller.address);
const confirmationTx = await escrow.connect(buyer).confirmDelivery(transactionId);
const confirmationReceipt = await confirmationTx.wait();
recordReceipt("buyer confirms delivery and releases funds", confirmationReceipt, escrow);

const completed = await escrow.getTransaction(transactionId);
if (completed.status !== 3n) throw new Error("Escrow transaction did not complete");
if ((await token.balanceOf(deployment.escrow)) !== escrowBalanceBeforePurchase) {
  throw new Error("Escrow balance did not return to its pre-purchase level");
}
if ((await token.balanceOf(seller.address)) !== sellerBalanceBefore + amount) {
  throw new Error("Seller did not receive the exact escrowed amount");
}

const result = {
  chainId: chain.chainId.toString(),
  verifiedAt: new Date().toISOString(),
  contractAddresses: contracts,
  token: {
    name: await token.name(),
    symbol: await token.symbol(),
    totalSupply: (await token.totalSupply()).toString(),
    developmentAllocation: developmentAllocation.toString(),
    currentBalances: {
      buyer: (await token.balanceOf(buyer.address)).toString(),
      seller: (await token.balanceOf(seller.address)).toString(),
      disputeResolver: (await token.balanceOf(resolver.address)).toString(),
    },
  },
  permissions: {
    marketplaceToken: await marketplace.token(),
    marketplaceEscrow: await marketplace.escrow(),
    escrowToken: await escrow.token(),
    escrowMarketplace: await escrow.marketplace(),
    disputeResolver: await escrow.disputeResolver(),
  },
  purchase: {
    listingId: listingId.toString(),
    transactionId: transactionId.toString(),
    buyer: funded.buyer,
    seller: funded.seller,
    amount: amount.toString(),
    finalStatus: "COMPLETED",
    escrowBalanceBeforePurchase: escrowBalanceBeforePurchase.toString(),
    escrowBalanceAfterRelease: (await token.balanceOf(deployment.escrow)).toString(),
    sellerBalanceAfterRelease: (await token.balanceOf(seller.address)).toString(),
  },
  unauthorizedConfirmation: {
    rejected: true,
    caller: other.address,
    error: parsedRevert.name,
    executedAs: "local eth_call; no transaction receipt is produced for a reverted simulation",
  },
  evidence,
};

await writeFile(
  path.join(deploymentDirectory, "verification-local.json"),
  `${JSON.stringify(result, null, 2)}\n`,
  "utf8"
);

console.log(JSON.stringify(result, null, 2));
