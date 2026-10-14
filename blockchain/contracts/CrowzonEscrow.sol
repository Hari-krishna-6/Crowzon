// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract CrowzonEscrow is ReentrancyGuard {
    using Address for address payable;

    uint256 public constant DELIVERY_WINDOW = 7 days;
    uint256 public constant BUYER_REVIEW_PERIOD = 7 days;
    uint256 public constant DISPUTE_RESOLUTION_PERIOD = 30 days;

    enum Status {
        FUNDED,
        DELIVERED,
        DISPUTED,
        COMPLETED,
        REFUNDED
    }

    enum RefundReason {
        BuyerCancelled,
        DeliveryTimeout,
        ResolverDecision,
        DisputeTimeout
    }

    struct EscrowTransaction {
        address buyer;
        address seller;
        uint256 listingId;
        uint256 amount;
        uint256 fundedAt;
        uint256 deliveredAt;
        uint256 disputedAt;
        Status status;
    }

    address public immutable marketplace;
    address public immutable disputeResolver;
    uint256 public nextTransactionId = 1;

    mapping(uint256 transactionId => EscrowTransaction transaction) private _transactions;

    error ZeroAddress();
    error NotMarketplace();
    error Unauthorized();
    error TransactionNotFound();
    error InvalidAmount();
    error InvalidState();
    error DeliveryWindowExpired();
    error DeliveryWindowNotExpired();
    error ReviewPeriodNotExpired();
    error DisputeResolutionPeriodNotExpired();
    error DisputeNotEligible();
    error TransferFailed();

    event PurchaseFunded(
        uint256 indexed transactionId,
        uint256 indexed listingId,
        address indexed buyer,
        address seller,
        uint256 amount
    );
    event DeliveryMarked(uint256 indexed transactionId, address indexed seller);
    event DeliveryConfirmed(uint256 indexed transactionId, address indexed buyer);
    event DisputeRaised(uint256 indexed transactionId, address indexed raisedBy);
    event DisputeResolved(
        uint256 indexed transactionId,
        address indexed resolver,
        bool releasedToSeller
    );
    event PaymentReleased(
        uint256 indexed transactionId,
        address indexed seller,
        uint256 amount
    );
    event RefundIssued(
        uint256 indexed transactionId,
        address indexed buyer,
        uint256 amount,
        RefundReason reason
    );

    constructor(address marketplaceAddress, address resolver) {
        if (marketplaceAddress == address(0) || resolver == address(0)) {
            revert ZeroAddress();
        }

        marketplace = marketplaceAddress;
        disputeResolver = resolver;
    }

    modifier onlyMarketplace() {
        if (msg.sender != marketplace) revert NotMarketplace();
        _;
    }

    function createPurchase(
        address buyer,
        address seller,
        uint256 listingId,
        uint256 amount
    ) external payable onlyMarketplace nonReentrant returns (uint256 transactionId) {
        if (buyer == address(0) || seller == address(0)) revert ZeroAddress();
        if (buyer == seller) revert Unauthorized();
        if (amount == 0 || msg.value != amount) revert InvalidAmount();

        transactionId = nextTransactionId++;
        _transactions[transactionId] = EscrowTransaction({
            buyer: buyer,
            seller: seller,
            listingId: listingId,
            amount: amount,
            fundedAt: block.timestamp,
            deliveredAt: 0,
            disputedAt: 0,
            status: Status.FUNDED
        });

        emit PurchaseFunded(transactionId, listingId, buyer, seller, amount);
    }

    function getTransaction(
        uint256 transactionId
    ) external view returns (EscrowTransaction memory transaction) {
        transaction = _transactions[transactionId];
        if (transaction.buyer == address(0)) revert TransactionNotFound();
    }

    function markDelivered(uint256 transactionId) external {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (msg.sender != transaction.seller) revert Unauthorized();
        if (transaction.status != Status.FUNDED) revert InvalidState();
        if (block.timestamp > transaction.fundedAt + DELIVERY_WINDOW) {
            revert DeliveryWindowExpired();
        }

        transaction.status = Status.DELIVERED;
        transaction.deliveredAt = block.timestamp;

        emit DeliveryMarked(transactionId, msg.sender);
    }

    function confirmDelivery(uint256 transactionId) external nonReentrant {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (msg.sender != transaction.buyer) revert Unauthorized();
        if (transaction.status != Status.DELIVERED) revert InvalidState();

        transaction.status = Status.COMPLETED;
        _releaseFunds(transaction.seller, transaction.amount, transactionId);

        emit DeliveryConfirmed(transactionId, msg.sender);
    }

    function cancelBeforeDelivery(uint256 transactionId) external nonReentrant {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (msg.sender != transaction.buyer) revert Unauthorized();
        if (transaction.status != Status.FUNDED) revert InvalidState();

        _refund(transactionId, transaction, RefundReason.BuyerCancelled);
    }

    function refundUndelivered(uint256 transactionId) external nonReentrant {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (transaction.status != Status.FUNDED) revert InvalidState();
        if (block.timestamp < transaction.fundedAt + DELIVERY_WINDOW) {
            revert DeliveryWindowNotExpired();
        }

        _refund(transactionId, transaction, RefundReason.DeliveryTimeout);
    }

    function finalizeAfterReviewPeriod(uint256 transactionId) external nonReentrant {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (transaction.status != Status.DELIVERED) revert InvalidState();
        if (block.timestamp < transaction.deliveredAt + BUYER_REVIEW_PERIOD) {
            revert ReviewPeriodNotExpired();
        }

        transaction.status = Status.COMPLETED;
        _releaseFunds(transaction.seller, transaction.amount, transactionId);
    }

    function raiseDispute(uint256 transactionId) external {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (msg.sender != transaction.buyer && msg.sender != transaction.seller) {
            revert Unauthorized();
        }

        if (transaction.status == Status.FUNDED) {
            if (block.timestamp > transaction.fundedAt + DELIVERY_WINDOW) {
                revert DisputeNotEligible();
            }
        } else if (transaction.status == Status.DELIVERED) {
            if (block.timestamp > transaction.deliveredAt + BUYER_REVIEW_PERIOD) {
                revert DisputeNotEligible();
            }
        } else {
            revert InvalidState();
        }

        transaction.status = Status.DISPUTED;
        transaction.disputedAt = block.timestamp;

        emit DisputeRaised(transactionId, msg.sender);
    }

    function resolveDispute(
        uint256 transactionId,
        bool releaseToSeller
    ) external nonReentrant {
        if (msg.sender != disputeResolver) revert Unauthorized();

        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (transaction.status != Status.DISPUTED) revert InvalidState();

        emit DisputeResolved(transactionId, msg.sender, releaseToSeller);

        if (releaseToSeller) {
            transaction.status = Status.COMPLETED;
            _releaseFunds(transaction.seller, transaction.amount, transactionId);
        } else {
            _refund(transactionId, transaction, RefundReason.ResolverDecision);
        }
    }

    function refundUnresolvedDispute(uint256 transactionId) external nonReentrant {
        EscrowTransaction storage transaction = _getTransaction(transactionId);
        if (transaction.status != Status.DISPUTED) revert InvalidState();
        if (
            block.timestamp <
            transaction.disputedAt + DISPUTE_RESOLUTION_PERIOD
        ) {
            revert DisputeResolutionPeriodNotExpired();
        }

        _refund(transactionId, transaction, RefundReason.DisputeTimeout);
    }

    function _getTransaction(
        uint256 transactionId
    ) private view returns (EscrowTransaction storage transaction) {
        transaction = _transactions[transactionId];
        if (transaction.buyer == address(0)) revert TransactionNotFound();
    }

    function _releaseFunds(
        address recipient,
        uint256 amount,
        uint256 transactionId
    ) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert TransferFailed();
        emit PaymentReleased(transactionId, recipient, amount);
    }

    function _refund(
        uint256 transactionId,
        EscrowTransaction storage transaction,
        RefundReason reason
    ) private {
        transaction.status = Status.REFUNDED;
        (bool success, ) = payable(transaction.buyer).call{value: transaction.amount}("");
        if (!success) revert TransferFailed();

        emit RefundIssued(transactionId, transaction.buyer, transaction.amount, reason);
    }
}
