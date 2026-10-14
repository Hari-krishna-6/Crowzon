import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();
const PRICE = ethers.parseEther("100");

describe("Crowzon local marketplace and native-ETH escrow", function () {
  let buyer;
  let seller;
  let resolver;
  let other;
  let marketplace;
  let escrow;
  let listingId;

  async function deployFixture() {
    [buyer, seller, resolver, other] = await ethers.getSigners();

    marketplace = await ethers.deployContract("CrowzonMarketplace", [
      resolver.address,
    ]);
    await marketplace.waitForDeployment();
    escrow = await ethers.getContractAt(
      "CrowzonEscrow",
      await marketplace.escrow()
    );

    const tx = await marketplace.connect(seller).createListing("Handmade mug", PRICE);
    await tx.wait();
    listingId = 1n;
  }

  async function purchase() {
    await marketplace.connect(buyer).buyListing(listingId, { value: PRICE });
  }

  async function increaseTime(seconds) {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  beforeEach(async function () {
    await deployFixture();
  });

  describe("Listings and purchases", function () {
    it("creates a listing with its seller, description, price, and active state", async function () {
      const listing = await marketplace.getListing(listingId);
      expect(listing.seller).to.equal(seller.address);
      expect(listing.description).to.equal("Handmade mug");
      expect(listing.price).to.equal(PRICE);
      expect(listing.active).to.equal(true);
    });

    it("allows the seller to update and deactivate a listing", async function () {
      await expect(
        marketplace.connect(seller).updateListing(listingId, "Ceramic mug", PRICE * 2n)
      )
        .to.emit(marketplace, "ListingUpdated")
        .withArgs(listingId, "Ceramic mug", PRICE * 2n);

      await expect(marketplace.connect(seller).deactivateListing(listingId))
        .to.emit(marketplace, "ListingDeactivated")
        .withArgs(listingId, seller.address);

      expect((await marketplace.getListing(listingId)).active).to.equal(false);
      await expect(
        marketplace.connect(seller).deactivateListing(listingId)
      ).to.be.revertedWithCustomError(marketplace, "ListingInactive");
      await expect(
        marketplace.connect(buyer).updateListing(listingId, "Not mine", PRICE)
      ).to.be.revertedWithCustomError(marketplace, "Unauthorized");
    });

    it("rejects empty or zero-priced listings", async function () {
      await expect(
        marketplace.connect(seller).createListing("", PRICE)
      ).to.be.revertedWithCustomError(marketplace, "EmptyDescription");
      await expect(
        marketplace.connect(seller).createListing("Free", 0)
      ).to.be.revertedWithCustomError(marketplace, "InvalidPrice");
    });

    it("escrows an exact native ETH purchase and records its parties and amount", async function () {
      await expect(marketplace.connect(buyer).buyListing(listingId, { value: PRICE }))
        .to.emit(marketplace, "Purchased")
        .withArgs(listingId, 1n, buyer.address, seller.address, PRICE);

      const transaction = await escrow.getTransaction(1n);
      expect(transaction.buyer).to.equal(buyer.address);
      expect(transaction.seller).to.equal(seller.address);
      expect(transaction.listingId).to.equal(listingId);
      expect(transaction.amount).to.equal(PRICE);
      expect(transaction.status).to.equal(0n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(PRICE);
    });

    it("rejects purchases with the wrong ETH amount", async function () {
      await expect(
        marketplace.connect(buyer).buyListing(listingId, { value: PRICE - 1n })
      ).to.be.revertedWithCustomError(marketplace, "InvalidAmount");
    });

    it("rejects inactive listings, self-purchases, and missing listings", async function () {
      await expect(
        marketplace.connect(seller).buyListing(listingId, { value: PRICE })
      ).to.be.revertedWithCustomError(marketplace, "SelfPurchase");

      await marketplace.connect(seller).deactivateListing(listingId);
      await expect(
        marketplace.connect(buyer).buyListing(listingId, { value: PRICE })
      ).to.be.revertedWithCustomError(marketplace, "ListingInactive");
      await expect(
        marketplace.connect(buyer).buyListing(999n, { value: PRICE })
      ).to.be.revertedWithCustomError(marketplace, "ListingNotFound");
    });
  });

  describe("Escrow lifecycle", function () {
    beforeEach(async function () {
      await purchase();
    });

    it("lets only the seller mark delivery and the buyer confirm it", async function () {
      await expect(
        escrow.connect(buyer).markDelivered(1n)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");

      await expect(escrow.connect(seller).markDelivered(1n))
        .to.emit(escrow, "DeliveryMarked")
        .withArgs(1n, seller.address);

      await expect(
        escrow.connect(seller).confirmDelivery(1n)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");
      await expect(
        escrow.connect(other).confirmDelivery(1n)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      const receipt = await escrow.connect(buyer).confirmDelivery(1n);
      await receipt.wait();
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);

      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(PRICE);
      expect((await escrow.getTransaction(1n)).status).to.equal(3n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
    });

    it("prevents duplicate releases and invalid state transitions", async function () {
      await expect(
        escrow.connect(buyer).confirmDelivery(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(
        escrow.connect(seller).markDelivered(1n)
      ).to.emit(escrow, "DeliveryMarked");
      await escrow.connect(buyer).confirmDelivery(1n);

      await expect(
        escrow.connect(buyer).confirmDelivery(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(
        escrow.connect(seller).markDelivered(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(
        escrow.connect(buyer).raiseDispute(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });

    it("allows a buyer to cancel before seller delivery and blocks repeat refunds", async function () {
      await expect(escrow.connect(seller).cancelBeforeDelivery(1n))
        .to.be.revertedWithCustomError(escrow, "Unauthorized");

      await expect(escrow.connect(buyer).cancelBeforeDelivery(1n))
        .to.emit(escrow, "RefundIssued")
        .withArgs(1n, buyer.address, PRICE, 0);

      expect((await escrow.getTransaction(1n)).status).to.equal(4n);
      expect(await ethers.provider.getBalance(await escrow.getAddress())).to.equal(0n);
      await expect(
        escrow.connect(buyer).cancelBeforeDelivery(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
      await expect(
        escrow.refundUndelivered(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });

    it("refunds an undelivered purchase after the delivery deadline", async function () {
      await expect(
        escrow.refundUndelivered(1n)
      ).to.be.revertedWithCustomError(escrow, "DeliveryWindowNotExpired");

      await increaseTime(Number(await escrow.DELIVERY_WINDOW()));
      await expect(escrow.connect(other).refundUndelivered(1n))
        .to.emit(escrow, "RefundIssued")
        .withArgs(1n, buyer.address, PRICE, 1);

      expect((await escrow.getTransaction(1n)).status).to.equal(4n);
      await expect(
        escrow.connect(seller).markDelivered(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });

    it("releases funds if the buyer does not act within the review period", async function () {
      await escrow.connect(seller).markDelivered(1n);
      await expect(
        escrow.finalizeAfterReviewPeriod(1n)
      ).to.be.revertedWithCustomError(escrow, "ReviewPeriodNotExpired");

      await increaseTime(Number(await escrow.BUYER_REVIEW_PERIOD()));
      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      await expect(escrow.connect(other).finalizeAfterReviewPeriod(1n))
        .to.emit(escrow, "PaymentReleased")
        .withArgs(1n, seller.address, PRICE);
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(PRICE);
      expect((await escrow.getTransaction(1n)).status).to.equal(3n);
    });

    it("lets either party raise a dispute before the applicable deadline", async function () {
      await expect(escrow.connect(other).raiseDispute(1n))
        .to.be.revertedWithCustomError(escrow, "Unauthorized");

      await expect(escrow.connect(seller).raiseDispute(1n))
        .to.emit(escrow, "DisputeRaised")
        .withArgs(1n, seller.address);
      expect((await escrow.getTransaction(1n)).status).to.equal(2n);

      await expect(
        escrow.connect(buyer).raiseDispute(1n)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });

    it("allows only the designated resolver to decide a dispute", async function () {
      await escrow.connect(buyer).raiseDispute(1n);
      await expect(
        escrow.connect(other).resolveDispute(1n, true)
      ).to.be.revertedWithCustomError(escrow, "Unauthorized");

      const sellerBalanceBefore = await ethers.provider.getBalance(seller.address);
      await expect(escrow.connect(resolver).resolveDispute(1n, true))
        .to.emit(escrow, "DisputeResolved")
        .withArgs(1n, resolver.address, true);
      const sellerBalanceAfter = await ethers.provider.getBalance(seller.address);
      expect(sellerBalanceAfter - sellerBalanceBefore).to.equal(PRICE);
      expect((await escrow.getTransaction(1n)).status).to.equal(3n);
    });

    it("supports resolver-directed refunds and prevents duplicate resolution", async function () {
      await escrow.connect(buyer).raiseDispute(1n);
      await expect(escrow.connect(resolver).resolveDispute(1n, false))
        .to.emit(escrow, "RefundIssued")
        .withArgs(1n, buyer.address, PRICE, 2);

      expect((await escrow.getTransaction(1n)).status).to.equal(4n);
      await expect(
        escrow.connect(resolver).resolveDispute(1n, false)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });

    it("refunds an unresolved dispute after the resolution deadline", async function () {
      await escrow.connect(buyer).raiseDispute(1n);
      await expect(
        escrow.refundUnresolvedDispute(1n)
      ).to.be.revertedWithCustomError(escrow, "DisputeResolutionPeriodNotExpired");

      await increaseTime(Number(await escrow.DISPUTE_RESOLUTION_PERIOD()));
      await expect(escrow.connect(other).refundUnresolvedDispute(1n))
        .to.emit(escrow, "RefundIssued")
        .withArgs(1n, buyer.address, PRICE, 3);

      expect((await escrow.getTransaction(1n)).status).to.equal(4n);
      await expect(
        escrow.connect(resolver).resolveDispute(1n, true)
      ).to.be.revertedWithCustomError(escrow, "InvalidState");
    });

    it("rejects unknown transaction IDs", async function () {
      await expect(
        escrow.getTransaction(999n)
      ).to.be.revertedWithCustomError(escrow, "TransactionNotFound");
      await expect(
        escrow.connect(seller).markDelivered(999n)
      ).to.be.revertedWithCustomError(escrow, "TransactionNotFound");
    });

    it("does not allow direct untrusted calls to create funded transactions", async function () {
      await expect(
        escrow.connect(buyer).createPurchase(buyer.address, seller.address, listingId, PRICE, { value: PRICE })
      ).to.be.revertedWithCustomError(escrow, "NotMarketplace");
    });
  });
});
