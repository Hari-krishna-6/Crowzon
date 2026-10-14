// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract ReentrantTestToken is ERC20 {
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackAttempted;
    bool public callbackSucceeded;

    constructor(address initialHolder) ERC20("Reentrancy Test Token", "RTT") {
        _mint(initialHolder, 1_000 ether);
    }

    function setCallback(address target, bytes calldata data) external {
        callbackTarget = target;
        callbackData = data;
        callbackAttempted = false;
        callbackSucceeded = false;
    }

    function transfer(
        address to,
        uint256 value
    ) public override returns (bool) {
        bool success = super.transfer(to, value);
        _attemptCallback();
        return success;
    }

    function transferFrom(
        address from,
        address to,
        uint256 value
    ) public override returns (bool) {
        bool success = super.transferFrom(from, to, value);
        _attemptCallback();
        return success;
    }

    function _attemptCallback() private {
        if (callbackTarget == address(0) || callbackAttempted) return;

        callbackAttempted = true;
        (callbackSucceeded, ) = callbackTarget.call(callbackData);
    }
}
