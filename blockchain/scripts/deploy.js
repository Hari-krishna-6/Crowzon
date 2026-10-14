import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { network } from "hardhat";

const { ethers } = await network.create();
const chain = await ethers.provider.getNetwork();

if (chain.chainId !== 31337n) {
  throw new Error(`Refusing deployment on unexpected chain ID ${chain.chainId}`);
}

const signers = await ethers.getSigners();
if (signers.length < 6) {
  throw new Error("The local Hardhat node must provide at least six accounts");
}

const developmentAccounts = signers.slice(1, 6).map(({ address }) => address);
const resolver = signers[3];

const token = await ethers.deployContract("CrowzonToken", [developmentAccounts]);
await token.waitForDeployment();
const tokenReceipt = await token.deploymentTransaction().wait();

const marketplace = await ethers.deployContract("CrowzonMarketplace", [
  await token.getAddress(),
  resolver.address,
]);
await marketplace.waitForDeployment();
const marketplaceReceipt = await marketplace.deploymentTransaction().wait();
const escrowAddress = await marketplace.escrow();

if (
  (await ethers.provider.getCode(await token.getAddress())) === "0x" ||
  (await ethers.provider.getCode(await marketplace.getAddress())) === "0x" ||
  (await ethers.provider.getCode(escrowAddress)) === "0x"
) {
  throw new Error("Deployment completed without bytecode at every contract address");
}
if ((await token.symbol()) !== "CVT") {
  throw new Error("The deployed token has an unexpected symbol");
}
if ((await token.totalSupply()) !== ethers.parseUnits("1000000", 18)) {
  throw new Error("The deployed token has an unexpected supply");
}
const developmentAllocation = ethers.parseUnits("10000", 18);
for (const account of developmentAccounts) {
  if ((await token.balanceOf(account)) !== developmentAllocation) {
    throw new Error(`Unexpected initial token allocation for ${account}`);
  }
}

const deployment = {
  network: "localhost",
  localOnly: true,
  chainId: chain.chainId.toString(),
  deploymentId: randomUUID(),
  token: await token.getAddress(),
  marketplace: await marketplace.getAddress(),
  escrow: escrowAddress,
  tokenName: await token.name(),
  tokenSymbol: await token.symbol(),
  totalSupply: (await token.totalSupply()).toString(),
  developmentAllocation: developmentAllocation.toString(),
  deploymentTransactions: {
    token: {
      transactionHash: tokenReceipt.hash,
      blockNumber: tokenReceipt.blockNumber,
    },
    marketplaceAndEscrow: {
      transactionHash: marketplaceReceipt.hash,
      blockNumber: marketplaceReceipt.blockNumber,
    },
  },
  accounts: {
    deployer: signers[0].address,
    buyer: signers[1].address,
    seller: signers[2].address,
    disputeResolver: resolver.address,
    additionalDevelopmentAccounts: signers.slice(4, 6).map(({ address }) => address),
  },
};

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const deploymentDirectory = path.resolve(scriptDirectory, "..", "deployments");
await mkdir(deploymentDirectory, { recursive: true });
await writeFile(
  path.join(deploymentDirectory, "localhost.json"),
  `${JSON.stringify(deployment, null, 2)}\n`,
  { flag: "w" }
);

console.log(`CrowzonToken: ${deployment.token}`);
console.log(`CrowzonMarketplace: ${deployment.marketplace}`);
console.log(`CrowzonEscrow: ${deployment.escrow}`);
console.log(`Development deployment details: ${path.join(deploymentDirectory, "localhost.json")}`);
