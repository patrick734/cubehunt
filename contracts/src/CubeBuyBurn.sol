// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta, BalanceDeltaLibrary} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title CubeBuyBurn
/// @notice Receives CubeHunt fees (ETH share fees, ETH and USDG deposit fees), buys $CUBE with them in its Pons pool
///         (native ETH / $CUBE) and burns every $CUBE it holds. USDG goes USDG -> ETH (hookless ETH/USDG pool) ->
///         $CUBE inside one PoolManager unlock.
/// @dev There is no withdrawal path: ETH and USDG leave only as a swap into $CUBE, and $CUBE only as a burn. $CUBE is
///      set once by the admin (the 48h DAO timelock) after the Pons launch. Keeper runs are capped and rate-limited,
///      and the keeper's own minimum output is checked. The admin must be a TimelockController with at least a 48h
///      delay in which the deployer holds no role.
contract CubeBuyBurn is AccessControl, ReentrancyGuard, IUnlockCallback {
    using BalanceDeltaLibrary for BalanceDelta;
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    uint256 public constant MIN_ADMIN_DELAY = 48 hours;

    IPoolManager public immutable poolManager;
    address public immutable ponsHook;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    address public immutable usdg;
    uint24 public immutable usdgPoolFee;
    int24 public immutable usdgTickSpacing;

    ERC20Burnable public token;
    /// @notice Who may set $CUBE once, while it is unset (the dev wallet that launches it on Pons). The admin can too.
    address public immutable tokenSetter;
    uint256 public maxEthPerRun;
    uint256 public maxUsdgPerRun;
    uint32 public minInterval;
    uint64 public lastBurn;
    bool public halted;
    uint256 public totalBurned;
    uint256 public totalEthSpent;
    uint256 public totalUsdgSpent;

    bool private _unlocking;

    event Burned(address indexed tokenIn, uint256 amountIn, uint256 tokensBurned, uint256 totalBurned);
    event TokenSet(address indexed token);
    event LimitsSet(uint256 maxEthPerRun, uint256 maxUsdgPerRun, uint32 minInterval);
    event HaltSet(bool halted);

    error InvalidConfig();
    error AdminNotTimelock();
    error TokenAlreadySet();
    error TokenUnset();
    error IsHalted();
    error OverLimit();
    error TooSoon();
    error Shortfall(uint256 received, uint256 minimum);
    error Unauthorized();

    struct PoolCfg {
        IPoolManager poolManager;
        address ponsHook;
        uint24 poolFee;
        int24 tickSpacing;
        address usdg;
        uint24 usdgPoolFee;
        int24 usdgTickSpacing;
    }

    constructor(
        PoolCfg memory c,
        address admin,
        address guardian,
        address keeper,
        uint256 maxEthPerRun_,
        uint256 maxUsdgPerRun_,
        uint32 minInterval_,
        address tokenSetter_
    ) {
        if (
            address(c.poolManager) == address(0) || c.ponsHook == address(0) || c.tickSpacing <= 0 || c.usdg == address(0)
                || c.usdgTickSpacing <= 0 || guardian == address(0) || keeper == address(0) || keeper == msg.sender
                || keeper == admin
        ) revert InvalidConfig();
        _requireTimelock(admin);
        poolManager = c.poolManager;
        ponsHook = c.ponsHook;
        poolFee = c.poolFee;
        tickSpacing = c.tickSpacing;
        usdg = c.usdg;
        usdgPoolFee = c.usdgPoolFee;
        usdgTickSpacing = c.usdgTickSpacing;
        tokenSetter = tokenSetter_;
        _setLimits(maxEthPerRun_, maxUsdgPerRun_, minInterval_);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, guardian);
        _grantRole(KEEPER_ROLE, keeper);
    }

    receive() external payable {}

    /// @notice The $CUBE / ETH Pons pool this contract buys from.
    function poolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(address(token)),
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: IHooks(ponsHook)
        });
    }

    /// @notice The hookless ETH / USDG pool USDG fees are sold through.
    function usdgPoolKey() public view returns (PoolKey memory) {
        return PoolKey({
            currency0: Currency.wrap(address(0)),
            currency1: Currency.wrap(usdg),
            fee: usdgPoolFee,
            tickSpacing: usdgTickSpacing,
            hooks: IHooks(address(0))
        });
    }

    /// @notice Buys $CUBE with `ethIn` of the ETH fees and burns everything held. Keeper only, capped, rate-limited.
    ///         Simulate it (eth_call) with minOut = 0 to quote.
    function burn(uint256 ethIn, uint256 minOut) external onlyRole(KEEPER_ROLE) nonReentrant returns (uint256 burned) {
        if (ethIn == 0 || ethIn > maxEthPerRun || ethIn > address(this).balance) revert OverLimit();
        burned = _run(address(0), ethIn, minOut);
        totalEthSpent += ethIn;
    }

    /// @notice Buys $CUBE with `usdgIn` of the USDG fees (through ETH) and burns everything held. Keeper only.
    function burnUsdg(uint256 usdgIn, uint256 minOut) external onlyRole(KEEPER_ROLE) nonReentrant returns (uint256 burned) {
        if (usdgIn == 0 || usdgIn > maxUsdgPerRun || usdgIn > IERC20(usdg).balanceOf(address(this))) revert OverLimit();
        burned = _run(usdg, usdgIn, minOut);
        totalUsdgSpent += usdgIn;
    }

    /// @notice Burns any $CUBE sent here directly. Anyone may call it.
    function burnHeld() external nonReentrant returns (uint256) {
        if (address(token) == address(0)) revert TokenUnset();
        return _burnHeld();
    }

    function _run(address tokenIn, uint256 amountIn, uint256 minOut) private returns (uint256 burned) {
        if (address(token) == address(0)) revert TokenUnset();
        if (halted) revert IsHalted();
        if (block.timestamp < uint256(lastBurn) + minInterval) revert TooSoon();
        lastBurn = uint64(block.timestamp);

        uint256 before = token.balanceOf(address(this));
        _unlocking = true;
        poolManager.unlock(abi.encode(tokenIn, amountIn));
        _unlocking = false;
        uint256 bought = token.balanceOf(address(this)) - before;
        if (bought < minOut) revert Shortfall(bought, minOut);
        burned = _burnHeld();
        emit Burned(tokenIn, amountIn, burned, totalBurned);
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager) || !_unlocking) revert Unauthorized();
        (address tokenIn, uint256 amountIn) = abi.decode(data, (address, uint256));

        uint256 ethIn = amountIn;
        if (tokenIn == usdg) {
            // USDG (currency1) -> ETH (currency0): oneForZero, exact input
            BalanceDelta d1 = poolManager.swap(
                usdgPoolKey(),
                SwapParams({zeroForOne: false, amountSpecified: -int256(amountIn), sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1}),
                bytes("")
            );
            if (d1.amount1() != -int128(int256(amountIn)) || d1.amount0() <= 0) revert Shortfall(0, 1);
            ethIn = uint256(uint128(d1.amount0()));
        }

        // ETH (currency0) -> $CUBE (currency1): zeroForOne, exact input
        BalanceDelta delta = poolManager.swap(
            poolKey(),
            SwapParams({zeroForOne: true, amountSpecified: -int256(ethIn), sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1}),
            bytes("")
        );
        int128 paid = delta.amount0();
        int128 received = delta.amount1();
        if (paid >= 0 || received <= 0) revert Shortfall(0, 1);

        if (tokenIn == usdg) {
            // the ETH leg nets out inside the unlock only if the second swap used all of it
            if (uint256(uint128(-paid)) != ethIn) revert Shortfall(0, 1);
            poolManager.sync(Currency.wrap(usdg));
            IERC20(usdg).safeTransfer(address(poolManager), amountIn);
            poolManager.settle();
        } else {
            poolManager.settle{value: uint256(uint128(-paid))}();
        }
        poolManager.take(Currency.wrap(address(token)), address(this), uint256(uint128(received)));
        return "";
    }

    function _burnHeld() private returns (uint256 amount) {
        amount = token.balanceOf(address(this));
        if (amount == 0) return 0;
        token.burn(amount);
        totalBurned += amount;
    }

    // ---------------------------------------------------------------- governance

    /// @notice Sets $CUBE after its Pons launch, once: by the token setter or the admin (timelock). Permanent.
    function setToken(ERC20Burnable token_) external {
        if (msg.sender != tokenSetter && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        if (address(token) != address(0)) revert TokenAlreadySet();
        if (address(token_).code.length == 0) revert InvalidConfig();
        token = token_;
        emit TokenSet(address(token_));
    }

    function setLimits(uint256 maxEthPerRun_, uint256 maxUsdgPerRun_, uint32 minInterval_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setLimits(maxEthPerRun_, maxUsdgPerRun_, minInterval_);
    }

    /// @notice Stops buying (funds stay here). Only the admin can resume.
    function halt() external onlyRole(GUARDIAN_ROLE) {
        halted = true;
        emit HaltSet(true);
    }

    function resume() external onlyRole(DEFAULT_ADMIN_ROLE) {
        halted = false;
        emit HaltSet(false);
    }

    function _setLimits(uint256 maxEthPerRun_, uint256 maxUsdgPerRun_, uint32 minInterval_) private {
        if (
            maxEthPerRun_ == 0 || maxEthPerRun_ > 10 ether || maxUsdgPerRun_ == 0 || maxUsdgPerRun_ > 50_000e6
                || minInterval_ < 5 minutes
        ) revert InvalidConfig();
        maxEthPerRun = maxEthPerRun_;
        maxUsdgPerRun = maxUsdgPerRun_;
        minInterval = minInterval_;
        emit LimitsSet(maxEthPerRun_, maxUsdgPerRun_, minInterval_);
    }

    /// @dev The admin must be a TimelockController with >= 48h delay in which the deployer has no role.
    function _requireTimelock(address admin) private view {
        if (admin.code.length == 0) revert AdminNotTimelock();
        TimelockController tl = TimelockController(payable(admin));
        uint256 delay;
        try tl.getMinDelay() returns (uint256 d) {
            delay = d;
        } catch {
            revert AdminNotTimelock();
        }
        if (delay < MIN_ADMIN_DELAY) revert AdminNotTimelock();
        address me = msg.sender;
        if (
            tl.hasRole(tl.DEFAULT_ADMIN_ROLE(), me) || tl.hasRole(tl.PROPOSER_ROLE(), me) || tl.hasRole(tl.EXECUTOR_ROLE(), me)
                || tl.hasRole(tl.CANCELLER_ROLE(), me)
        ) revert AdminNotTimelock();
    }
}
