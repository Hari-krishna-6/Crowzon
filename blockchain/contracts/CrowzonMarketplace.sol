// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CrowzonEscrow} from "./CrowzonEscrow.sol";

contract CrowzonMarketplace is ReentrancyGuard {
    struct Listing {
        address seller;
        string description;
        uint256 price;
        bool active;
    }

    CrowzonEscrow public immutable escrow;
    uint256 public nextListingId = 1;

    mapping(uint256 listingId => Listing listing) private _listings;

    error ZeroAddress();
    error EmptyDescription();
    error InvalidPrice();
    error ListingNotFound();
    error Unauthorized();
    error ListingInactive();
    error SelfPurchase();
    error InvalidAmount();

    event ListingCreated(
        uint256 indexed listingId,
        address indexed seller,
        string description,
        uint256 price
    );
    event ListingUpdated(
        uint256 indexed listingId,
        string description,
        uint256 price
    );
    event ListingDeactivated(uint256 indexed listingId, address indexed seller);
    event Purchased(
        uint256 indexed listingId,
        uint256 indexed transactionId,
        address indexed buyer,
        address seller,
        uint256 amount
    );

    constructor(address disputeResolver) {
        if (disputeResolver == address(0)) revert ZeroAddress();
        escrow = new CrowzonEscrow(address(this), disputeResolver);
    }

    function createListing(
        string calldata description,
        uint256 price
    ) external returns (uint256 listingId) {
        if (bytes(description).length == 0) revert EmptyDescription();
        if (price == 0) revert InvalidPrice();

        listingId = nextListingId++;
        _listings[listingId] = Listing({
            seller: msg.sender,
            description: description,
            price: price,
            active: true
        });

        emit ListingCreated(listingId, msg.sender, description, price);
    }

    function getListing(
        uint256 listingId
    ) external view returns (Listing memory listing) {
        listing = _listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
    }

    function updateListing(
        uint256 listingId,
        string calldata description,
        uint256 price
    ) external {
        Listing storage listing = _getListing(listingId);
        if (msg.sender != listing.seller) revert Unauthorized();
        if (!listing.active) revert ListingInactive();
        if (bytes(description).length == 0) revert EmptyDescription();
        if (price == 0) revert InvalidPrice();

        listing.description = description;
        listing.price = price;

        emit ListingUpdated(listingId, description, price);
    }

    function deactivateListing(uint256 listingId) external {
        Listing storage listing = _getListing(listingId);
        if (msg.sender != listing.seller) revert Unauthorized();
        if (!listing.active) revert ListingInactive();

        listing.active = false;

        emit ListingDeactivated(listingId, msg.sender);
    }

    function buyListing(
        uint256 listingId
    ) external payable nonReentrant returns (uint256 transactionId) {
        Listing storage listing = _getListing(listingId);
        if (!listing.active) revert ListingInactive();
        if (msg.sender == listing.seller) revert SelfPurchase();
        if (msg.value != listing.price) revert InvalidAmount();

        transactionId = escrow.createPurchase{value: msg.value}(
            msg.sender,
            listing.seller,
            listingId,
            msg.value
        );

        emit Purchased(
            listingId,
            transactionId,
            msg.sender,
            listing.seller,
            listing.price
        );
    }

    function _getListing(
        uint256 listingId
    ) private view returns (Listing storage listing) {
        listing = _listings[listingId];
        if (listing.seller == address(0)) revert ListingNotFound();
    }
}
