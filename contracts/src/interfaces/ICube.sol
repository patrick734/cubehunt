// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink price feed (EACAggregatorProxy on Robinhood Chain).
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

interface ICubePoints {
    function mint(address to, uint256 amount, uint8 reason) external;
}

interface ICubeVaults {
    function huntVaultOf(uint16 k) external view returns (uint256);
    function releaseHunt(uint256 vaultId, address finder) external returns (bool paid);
}
