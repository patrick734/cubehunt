// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, toBalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";

/// Test-only ERC20 with open minting.
contract MockERC20 is ERC20 {
    uint8 private immutable _dec;

    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) {
        _dec = d;
    }

    function decimals() public view override returns (uint8) {
        return _dec;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Test-only burnable token standing in for $CUBE.
contract MockCube is ERC20Burnable {
    constructor() ERC20("CubeHunt", "CUBE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Test-only Chainlink feed.
contract MockAggregator {
    uint8 public immutable decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 d, int256 a) {
        decimals = d;
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 at) external {
        answer = a;
        updatedAt = at;
    }

    function description() external pure returns (string memory) {
        return "mock";
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

interface IUnlockCallbackMock {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// Test-only PoolManager: a swap pays `rate` output per input of the pool's other currency, from balances it was
/// funded with, and records what was settled.
contract MockPoolManager {
    mapping(address => uint256) public rateTimes1000; // keyed by the output currency
    uint256 public settledNative;
    uint256 public settledErc20;
    address public synced;
    uint256 private _syncedBalance;

    receive() external payable {}

    function setRate(address out, uint256 r) external {
        rateTimes1000[out] = r;
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        return IUnlockCallbackMock(msg.sender).unlockCallback(data);
    }

    function swap(PoolKey memory key, SwapParams memory p, bytes calldata) external view returns (BalanceDelta) {
        int128 amountIn = int128(-p.amountSpecified);
        address out = Currency.unwrap(p.zeroForOne ? key.currency1 : key.currency0);
        int128 got = int128(int256((uint256(int256(amountIn)) * rateTimes1000[out]) / 1000));
        return p.zeroForOne ? toBalanceDelta(-amountIn, got) : toBalanceDelta(got, -amountIn);
    }

    function sync(Currency c) external {
        synced = Currency.unwrap(c);
        _syncedBalance = IERC20(synced).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (msg.value > 0) {
            settledNative += msg.value;
            return msg.value;
        }
        paid = IERC20(synced).balanceOf(address(this)) - _syncedBalance;
        settledErc20 += paid;
    }

    function take(Currency c, address to, uint256 amount) external {
        address t = Currency.unwrap(c);
        if (t == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            require(ok, "ETH send failed");
        } else {
            IERC20(t).transfer(to, amount);
        }
    }
}
