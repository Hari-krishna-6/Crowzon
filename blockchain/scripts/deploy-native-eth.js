import { mkdir, rename, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { network } from "hardhat";

const connection = await network.create({ network: "localhost" });
const { ethers } = connection;

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const deploymentDirectory = path.resolve(scriptDirectory, "..", "deployments");
const artifactPath = path.join(deploymentDirectory, "localhost-native-eth.json");

if (connection.networkName !== "localhost") {
  throw new Error(
    "This deployment script must be run with the localhost target. It is not safe to deploy to an ephemeral Hardhat network.",
  );
}

const chain = await ethers.provider.getNetwork();
if (chain.chainId !== 31337n) {
  throw new Error(`Refusing deployment on unexpected chain ID ${chain.chainId}. Configure the localhost network only.`);
}

const [deployer, buyer, seller, resolver, other] = await ethers.getSigners();

const marketplaceFactory = await ethers.getContractFactory("CrowzonMarketplace");
const escrowFactory = await ethers.getContractFactory("CrowzonEscrow");
const marketplace = await marketplaceFactory.deploy(resolver.address);
await marketplace.waitForDeployment();
const marketplaceDeploymentTx = marketplace.deploymentTransaction();
if (!marketplaceDeploymentTx) {
  throw new Error("Native-ETH deployment did not produce a deployment transaction.");
}
const marketplaceReceipt = await marketplaceDeploymentTx.wait();
if (!marketplaceReceipt || marketplaceReceipt.status !== 1) {
  throw new Error(
    `Native-ETH marketplace deployment transaction failed before confirmation. Hash: ${marketplaceDeploymentTx.hash}; status: ${marketplaceReceipt?.status ?? "unknown"}`,
  );
}

const escrowAddress = await marketplace.escrow();
const escrow = await ethers.getContractAt("CrowzonEscrow", escrowAddress);

if (
  (await ethers.provider.getCode(await marketplace.getAddress())) === "0x" ||
  (await ethers.provider.getCode(escrowAddress)) === "0x"
) {
  throw new Error("Native-ETH deployment completed without bytecode at every contract address.");
}

const marketplaceCode = await ethers.provider.getCode(await marketplace.getAddress());
const escrowCode = await ethers.provider.getCode(escrowAddress);
if (marketplaceCode === "0x" || escrowCode === "0x") {
  throw new Error("Native-ETH deployment verification failed: contract bytecode missing on the configured localhost network.");
}

if ((await marketplace.escrow()).toLowerCase() !== escrowAddress.toLowerCase()) {
  throw new Error("Deployed marketplace does not match the expected escrow address.");
}
if ((await escrow.marketplace()).toLowerCase() !== (await marketplace.getAddress()).toLowerCase()) {
  throw new Error("Deployed escrow does not match the expected marketplace address.");
}
if ((await escrow.disputeResolver()).toLowerCase() !== resolver.address.toLowerCase()) {
  throw new Error("Deployed escrow does not use the expected dispute resolver.");
}

const deployment = {
  network: "localhost-native-eth",
  localOnly: true,
  chainId: chain.chainId.toString(),
  deploymentId: randomUUID(),
  paymentCurrency: "ETH",
  marketplace: await marketplace.getAddress(),
  escrow: escrowAddress,
  marketplaceAbi: JSON.parse(marketplaceFactory.interface.formatJson()),
  escrowAbi: JSON.parse(escrowFactory.interface.formatJson()),
  accounts: {
    deployer: deployer.address,
    buyer: buyer.address,
    seller: seller.address,
    disputeResolver: resolver.address,
    additionalDevelopmentAccounts: [other.address],
  },
  deploymentTransactions: {
    marketplaceAndEscrow: {
      transactionHash: marketplaceReceipt.hash,
      blockNumber: marketplaceReceipt.blockNumber,
    },
  },
  notes: {
    generatedFrom: "Crowzon native ETH deployment",
    preservesLegacyDeployment: "The legacy CVT deployment artifact at localhost.json is not overwritten.",
  },
};

await mkdir(deploymentDirectory, { recursive: true });
const tempArtifactPath = `${artifactPath}.tmp`;
await writeFile(tempArtifactPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf8");

const persisted = JSON.parse(await readFile(tempArtifactPath, "utf8"));
const persistedMarketplace = await ethers.getContractAt("CrowzonMarketplace", persisted.marketplace);
const persistedEscrow = await ethers.getContractAt("CrowzonEscrow", persisted.escrow);
if ((await persistedMarketplace.escrow()).toLowerCase() !== persisted.escrow.toLowerCase()) {
  throw new Error("Persisted marketplace artifact does not match the deployed escrow address.");
}
if ((await persistedEscrow.marketplace()).toLowerCase() !== persisted.marketplace.toLowerCase()) {
  throw new Error("Persisted escrow artifact does not match the deployed marketplace address.");
}
if ((await persistedEscrow.disputeResolver()).toLowerCase() !== persisted.accounts.disputeResolver.toLowerCase()) {
  throw new Error("Persisted dispute resolver does not match the deployed escrow resolver.");
}

await rename(tempArtifactPath, artifactPath);

console.log(`Native ETH deployment artifact written to ${artifactPath}`);
console.log(`CrowzonMarketplace: ${persisted.marketplace}`);
console.log(`CrowzonEscrow: ${persisted.escrow}`);
console.log(`chainId: ${persisted.chainId}`);
