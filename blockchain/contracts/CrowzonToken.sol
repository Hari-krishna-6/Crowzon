// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract CrowzonToken is ERC20 {
    uint256 public constant INITIAL_SUPPLY = 1_000_000 * 10 ** 18;
    uint256 public constant DEVELOPMENT_ALLOCATION = 10_000 * 10 ** 18;

    error ZeroAddress();
    error TooManyDevelopmentAccounts();

    constructor(
        address[] memory developmentAccounts
    ) ERC20("Crowzon Virtual Token", "CVT") {
        if (developmentAccounts.length > INITIAL_SUPPLY / DEVELOPMENT_ALLOCATION) {
            revert TooManyDevelopmentAccounts();
        }

        for (uint256 i = 0; i < developmentAccounts.length; i++) {
            if (developmentAccounts[i] == address(0)) revert ZeroAddress();
            _mint(developmentAccounts[i], DEVELOPMENT_ALLOCATION);
        }

        _mint(
            msg.sender,
            INITIAL_SUPPLY - developmentAccounts.length * DEVELOPMENT_ALLOCATION
        );
    }
}
