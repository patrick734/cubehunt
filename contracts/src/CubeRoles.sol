// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title CubeRoles
/// @notice Two roles shared by every CubeHunt contract. The guardian runs launch setup (targets, prize vaults,
/// attestors) and its powers END on their own at `guardianUntil`, fixed at deploy and at most GUARDIAN_MAX_TERM
/// away. The DAO (the 48h TimelockController behind CubeGovernor) can do everything the guardian can, plus the money
/// moves and every setting that could create votes, and can remove the guardian early.
/// @dev Based on Ponmath's PonmathRoles (MIT). Changes: the guardian sunset.
abstract contract CubeRoles {
    /// @notice Longest a guardian term can be set at deploy.
    uint256 public constant GUARDIAN_MAX_TERM = 90 days;

    /// @notice Current guardian. address(0) once the DAO removed it or it renounced.
    address public guardian;
    /// @notice The DAO timelock. Immutable.
    address public immutable dao;
    /// @notice After this time the guardian has no powers left, whatever `guardian` says.
    uint64 public immutable guardianUntil;

    event GuardianChanged(address indexed previousGuardian, address indexed newGuardian);

    error NotGuardianOrDao();
    error NotDao();
    error NotGuardian();
    error ZeroAddress();
    error BadGuardianTerm();

    modifier onlyGuardianOrDao() {
        if (msg.sender != dao && !_isGuardian(msg.sender)) revert NotGuardianOrDao();
        _;
    }

    modifier onlyDao() {
        if (msg.sender != dao) revert NotDao();
        _;
    }

    constructor(address guardian_, address dao_, uint64 guardianUntil_) {
        if (dao_ == address(0)) revert ZeroAddress();
        if (guardianUntil_ < block.timestamp || guardianUntil_ > block.timestamp + GUARDIAN_MAX_TERM) revert BadGuardianTerm();
        guardian = guardian_;
        dao = dao_;
        guardianUntil = guardianUntil_;
        emit GuardianChanged(address(0), guardian_);
    }

    /// @notice DAO only: replace or remove (address(0)) the guardian. The term does not move.
    function setGuardian(address newGuardian) external onlyDao {
        emit GuardianChanged(guardian, newGuardian);
        guardian = newGuardian;
    }

    /// @notice The guardian gives up its role for good.
    function renounceGuardian() external {
        if (msg.sender != guardian || guardian == address(0)) revert NotGuardian();
        emit GuardianChanged(guardian, address(0));
        guardian = address(0);
    }

    /// @notice True while a guardian is set and its term has not ended.
    function guardianActive() public view returns (bool) {
        return guardian != address(0) && block.timestamp < guardianUntil;
    }

    /// @dev True when `account` is the live guardian and its term has not ended.
    function _isGuardian(address account) internal view returns (bool) {
        return account == guardian && account != address(0) && block.timestamp < guardianUntil;
    }
}
