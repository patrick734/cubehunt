// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {CubeRoles} from "./CubeRoles.sol";

/// @title CubePoints (PTS)
/// @dev Based on Ponmath's PonmathPoints (MIT). Changes: the guardian can only make contracts minters.
/// @notice Non-transferable points with votes. Earned by mining shares (CubeHunt), by funding prize vaults
/// (CubeVaults), by a chain-verified discovery, or by a DAO grant. Decimals 0: one unit is one point.
/// The clock is block.timestamp (Robinhood Chain blocks are about 0.1 s apart).
contract CubePoints is ERC20, ERC20Votes, CubeRoles {
    uint8 public constant MINING = 0;
    uint8 public constant PATRON = 1;
    uint8 public constant DISCOVERY = 2;
    uint8 public constant GRANT = 3;
    uint8 public constant REASONS = 4;

    /// @notice Contracts (and the timelock) allowed to mint.
    mapping(address => bool) public isMinter;
    /// @notice Once true (or once the first point exists) only the DAO can change minters.
    bool public mintersSealed;

    mapping(address => uint256[4]) private _earned;
    uint256[4] private _totalEarned;
    address[] private _holders;
    mapping(address => bool) public isHolder;

    event MinterSet(address indexed minter, bool allowed, address indexed by);
    event MintersSealed();
    event PointsMinted(address indexed to, uint256 amount, uint8 indexed reason, address indexed minter);

    error Soulbound();
    error NotMinter();
    error BadReason();
    error ZeroAmount();
    error MintersAreSealed();
    error NotAContract();

    constructor(address guardian_, address dao_, uint64 guardianUntil_)
        ERC20("CubeHunt Points", "PTS")
        EIP712("CubeHunt Points", "1")
        CubeRoles(guardian_, dao_, guardianUntil_)
    {}

    // ------------------------------------------------------------------------------------------------ token shape

    function decimals() public pure override returns (uint8) {
        return 0;
    }

    function clock() public view override returns (uint48) {
        return uint48(block.timestamp);
    }

    // solhint-disable-next-line func-name-mixedcase
    function CLOCK_MODE() public pure override returns (string memory) {
        return "mode=timestamp";
    }

    /// @notice Points never move between accounts. Votes can still be delegated.
    function transfer(address, uint256) public pure override returns (bool) {
        revert Soulbound();
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        revert Soulbound();
    }

    function approve(address, uint256) public pure override returns (bool) {
        revert Soulbound();
    }

    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
        if (from != address(0)) revert Soulbound();
        super._update(from, to, value);
    }

    // ------------------------------------------------------------------------------------------------ minting

    /// @notice Guardian (during setup only) or DAO: allow or stop a minter.
    function setMinter(address minter, bool allowed) external {
        if (msg.sender != dao) {
            if (!_isGuardian(msg.sender)) revert NotGuardianOrDao();
            if (mintersSealed || totalSupply() != 0) revert MintersAreSealed();
            // the guardian can only wire up contracts (Hunt, Vaults), never make a wallet a minter
            if (allowed && minter.code.length == 0) revert NotAContract();
        }
        if (minter == address(0)) revert ZeroAddress();
        isMinter[minter] = allowed;
        emit MinterSet(minter, allowed, msg.sender);
    }

    /// @notice Guardian or DAO: end the guardian's say over minters (the deploy script calls this).
    function sealMinters() external onlyGuardianOrDao {
        mintersSealed = true;
        emit MintersSealed();
    }

    /// @notice Mint `amount` points to `to` for `reason` (0 MINING, 1 PATRON, 2 DISCOVERY, 3 GRANT).
    /// The first mint to an account delegates its votes to itself, so voting needs no extra transaction.
    function mint(address to, uint256 amount, uint8 reason) external {
        if (!isMinter[msg.sender]) revert NotMinter();
        if (reason >= REASONS) revert BadReason();
        if (amount == 0) revert ZeroAmount();
        if (to == address(0)) revert ZeroAddress();
        if (!isHolder[to]) {
            isHolder[to] = true;
            _holders.push(to);
        }
        if (delegates(to) == address(0)) _delegate(to, to);
        _earned[to][reason] += amount;
        _totalEarned[reason] += amount;
        _mint(to, amount);
        emit PointsMinted(to, amount, reason, msg.sender);
    }

    // ------------------------------------------------------------------------------------------------ views

    /// @notice Points `account` earned for one reason.
    function earned(address account, uint8 reason) external view returns (uint256) {
        if (reason >= REASONS) revert BadReason();
        return _earned[account][reason];
    }

    /// @notice Points `account` earned per reason: [mining, patron, discovery, grant].
    function earnedAll(address account) external view returns (uint256[4] memory) {
        return _earned[account];
    }

    /// @notice Points minted so far per reason: [mining, patron, discovery, grant].
    function totalEarned() external view returns (uint256[4] memory) {
        return _totalEarned;
    }

    /// @notice One call for a dashboard: balance, current votes, delegate, earned per reason, holder index known.
    function accountInfo(address account)
        external
        view
        returns (uint256 balance, uint256 votes, address delegatee, uint256[4] memory byReason)
    {
        return (balanceOf(account), getVotes(account), delegates(account), _earned[account]);
    }

    function holderCount() external view returns (uint256) {
        return _holders.length;
    }

    /// @notice Holders in first-mint order with their balances. Returns fewer than `limit` at the end.
    function holders(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, uint256[] memory balances)
    {
        uint256 n = _holders.length;
        if (offset >= n) return (new address[](0), new uint256[](0));
        uint256 end = limit > n - offset ? n : offset + limit;
        accounts = new address[](end - offset);
        balances = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            accounts[i - offset] = _holders[i];
            balances[i - offset] = balanceOf(_holders[i]);
        }
    }
}
