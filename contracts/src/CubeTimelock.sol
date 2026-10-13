// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title CubeTimelock
/// @notice The CubeHunt DAO's 48-hour timelock: OpenZeppelin's TimelockController, unchanged. The deploy makes
/// CubeGovernor the only proposer and canceller, lets anyone execute a passed vote after the delay, and leaves the
/// timelock as its own admin: no wallet, the dev wallet included, holds any role in it.
contract CubeTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
