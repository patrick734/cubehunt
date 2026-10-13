// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CubeRoles} from "./CubeRoles.sol";
import {ICubePoints, ICubeVaults} from "./interfaces/ICube.sol";

/// @title CubeHunt
/// @dev Based on Ponmath's PonmathHunt (MIT). Changes: a small ETH fee per accepted share goes to the $CUBE BuyBurn;
/// the guardian can start only the first season (later seasons, and the fee, are DAO-only); points per share capped
/// at 1,000; guardian powers end at guardianUntil (CubeRoles).
/// @notice Open-problem mining for x^3 + y^3 + z^3 = k. Browsers search; this contract checks every share in full
/// and pays a jackpot itself when a candidate is a real solution.
///
/// A candidate (k, z, d) with d = x + y is a share when (SPEC 2.2):
///   1. the target is open and not paused; zMin <= |z| < zMax; d != 0; sign(d) = -sign(z); 3|d| <= |z|
///   2. (k - z^3) mod d == 0; q = (k - z^3)/d; N = 4q - d^2; N mod 3 == 0; Delta = N/3 >= 0
///   3. Delta is a square mod 64, 7, 11, 13, 17, 19, 23, 29 and 31
///   4. r^2 <= Delta < (r+1)^2 for the supplied r
///   5. keccak256(abi.encode(SHARE_TAG, chainid, this, uint16 k, z, d, r, miner, uint32 season)) >> (256 - bits) == 0
///   6. it was never submitted before (key keccak256(abi.encode(uint16 k, z, d)))
/// and a solution when r^2 == Delta and d - r is even: x = (d + r)/2, y = (d - r)/2.
contract CubeHunt is CubeRoles, ReentrancyGuard {
    bytes32 public constant SHARE_TAG = keccak256("CUBEHUNT_SHARE_V1");

    // bit i set when i is a square modulo m (same values as data/vectors/shares.json "masks")
    uint256 internal constant SQ64 = 0x202021202030213;
    uint256 internal constant SQ7 = 0x17;
    uint256 internal constant SQ11 = 0x23b;
    uint256 internal constant SQ13 = 0x161b;
    uint256 internal constant SQ17 = 0x1a317;
    uint256 internal constant SQ19 = 0x30af3;
    uint256 internal constant SQ23 = 0x5335f;
    uint256 internal constant SQ29 = 0x13d122f3;
    uint256 internal constant SQ31 = 0x121d47b7;

    /// @notice Bands and revealed coordinates stay below 2^84, so every cube and every sum fits in int256.
    uint256 public constant MAX_COORD = 1 << 84;
    uint256 public constant MAX_BATCH = 256;
    uint256 public constant DISCOVERY_POINTS = 1_000_000;
    uint64 public constant MAX_POINTS_PER_SHARE = 1_000;
    /// @notice Highest ETH fee per accepted share the DAO can set.
    uint256 public constant MAX_SHARE_FEE = 0.0001 ether;
    uint8 public constant MAX_BITS = 64;
    uint256 public constant COMMIT_MIN_AGE = 60;
    uint256 public constant COMMIT_MAX_AGE = 30 days;

    // checkShare reasons
    uint8 public constant OK = 0;
    uint8 public constant ZERO = 1;
    uint8 public constant BAND = 2;
    uint8 public constant SIGN = 3;
    uint8 public constant DBOUND = 4;
    uint8 public constant DIVIDES = 5;
    uint8 public constant MOD3 = 6;
    uint8 public constant NEGATIVE = 7;
    uint8 public constant FILTER = 8;
    uint8 public constant SQRT = 9;
    uint8 public constant HASH = 10;

    uint8 internal constant MINING = 0;
    uint8 internal constant DISCOVERY = 2;

    ICubePoints public immutable points;
    ICubeVaults public immutable vaults;

    struct Target {
        bool exists;
        bool solved;
        uint32 miners;
        uint64 shares;
        uint64 lastShareAt;
        uint64 addedAt;
        uint128 zMin;
        uint128 zMax;
        uint256 work;
    }

    struct Solution {
        address finder;
        uint64 solvedAt;
        uint32 season;
        bool viaReveal;
        int256 x;
        int256 y;
        int256 z;
    }

    struct Season {
        uint8 bits;
        uint64 pointsPerShare;
        uint64 startedAt;
        uint64 shares;
        uint32 miners;
    }

    struct Miner {
        uint64 shares;
        uint64 firstShareAt;
        uint64 lastShareAt;
        uint32 targets;
        uint256 work;
    }

    struct TargetView {
        uint16 k;
        bool exists;
        bool solved;
        uint256 zMin;
        uint256 zMax;
        uint256 shares;
        uint256 miners;
        uint256 lastShareAt;
        uint256 addedAt;
        uint256 work;
        uint256 vaultId;
        address finder;
        uint256 solvedAt;
        uint256 solvedSeason;
        bool viaReveal;
        int256 x;
        int256 y;
        int256 z;
    }

    struct SeasonView {
        uint32 id;
        uint8 bits;
        uint256 pointsPerShare;
        uint256 startedAt;
        uint256 shares;
        uint256 miners;
    }

    struct MinerView {
        uint256 shares;
        uint256 seasonShares;
        uint256 firstShareAt;
        uint256 lastShareAt;
        uint256 targets;
        uint256 work;
    }

    mapping(uint16 => Target) internal _targets;
    uint16[] internal _targetList;
    mapping(uint16 => Solution) internal _solutions;
    mapping(uint32 => Season) internal _seasons;
    mapping(address => Miner) internal _miners;
    address[] internal _minerList;

    /// @notice Current season id (0 before the first season starts).
    uint32 public season;
    /// @notice Where share fees go: the $CUBE BuyBurn. Immutable.
    address public immutable buyBurn;
    /// @notice ETH paid per accepted share (duplicates and the solution itself are free).
    uint256 public shareFee;
    /// @notice Total share fees sent to the BuyBurn.
    uint256 public totalFees;
    bool public paused;
    uint32 public solvedCount;
    uint64 public totalShares;
    /// @notice Sum over all accepted shares of 2^bits of their season: the expected number of filter survivors
    /// the shares stand for.
    uint256 public totalWork;

    mapping(address => mapping(uint16 => uint64)) public minerTargetShares;
    mapping(uint32 => mapping(address => uint64)) public seasonMinerShares;
    /// @notice First submitter of a candidate, by shareKey(k, z, d). One candidate counts once, ever.
    mapping(bytes32 => address) public shareOwner;
    /// @notice Solution commitments: finder => commitment => commit time.
    mapping(address => mapping(bytes32 => uint64)) public solutionCommitAt;

    event TargetAdded(uint16 indexed k, uint256 zMin, uint256 zMax, uint256 vaultId);
    event BandSet(uint16 indexed k, uint256 zMin, uint256 zMax);
    event SeasonStarted(uint32 indexed season, uint8 bits, uint64 pointsPerShare);
    event PausedSet(bool paused);
    event Share(address indexed miner, uint16 indexed k, uint32 indexed season, int256 z, int256 d, uint256 r);
    event SharesSubmitted(
        address indexed miner, uint16 indexed k, uint32 indexed season, uint256 accepted, uint256 skipped, uint256 points
    );
    event SolutionCommitted(address indexed finder, bytes32 indexed commitment);
    event Solved(uint16 indexed k, address indexed finder, int256 x, int256 y, int256 z, bool viaReveal);
    event JackpotPaid(uint16 indexed k, uint256 indexed vaultId, address indexed finder, bool paid);
    event JackpotPayoutFailed(uint16 indexed k, uint256 indexed vaultId, bytes reason);
    event DiscoveryPointsFailed(uint16 indexed k, address indexed finder);
    event ShareFeeSet(uint256 fee);
    event FeePaid(address indexed miner, uint256 amount);

    error UnknownTarget(uint16 k);
    error TargetExists(uint16 k);
    error TargetSolved(uint16 k);
    error TargetNotSolved(uint16 k);
    error BadTarget();
    error BadBand();
    error VaultMismatch(uint256 expected);
    error BadSeason();
    error NoSeason();
    error IsPaused();
    error EmptyBatch();
    error LengthMismatch();
    error BatchTooLarge();
    error InvalidShare(uint256 index, uint8 reason);
    error NothingAccepted();
    error AlreadyCommitted();
    error NoCommit();
    error CommitTooNew();
    error CommitExpired();
    error CoordinateOutOfRange();
    error NotASolution();
    error NothingToPay();
    error FeeTooLow(uint256 required);
    error BadFee();
    error FeeTransferFailed();
    error RefundFailed();

    constructor(
        address guardian_,
        address dao_,
        uint64 guardianUntil_,
        address points_,
        address vaults_,
        address buyBurn_,
        uint256 shareFee_
    ) CubeRoles(guardian_, dao_, guardianUntil_) {
        if (points_ == address(0) || vaults_ == address(0) || buyBurn_ == address(0)) revert ZeroAddress();
        if (shareFee_ > MAX_SHARE_FEE) revert BadFee();
        points = ICubePoints(points_);
        vaults = ICubeVaults(vaults_);
        buyBurn = buyBurn_;
        shareFee = shareFee_;
        emit ShareFeeSet(shareFee_);
    }

    /// @notice DAO only: the ETH fee per accepted share, at most MAX_SHARE_FEE.
    function setShareFee(uint256 fee) external onlyDao {
        if (fee > MAX_SHARE_FEE) revert BadFee();
        shareFee = fee;
        emit ShareFeeSet(fee);
    }

    // =========================================================================================== guardian or DAO

    /// @notice Add an open target. `vaultId` must equal vaults.huntVaultOf(k) (0 when k has no prize vault yet).
    function addTarget(uint16 k, uint256 zMin, uint256 zMax, uint256 vaultId) external onlyGuardianOrDao {
        if (k == 0) revert BadTarget();
        Target storage t = _targets[k];
        if (t.exists) revert TargetExists(k);
        _checkBand(zMin, zMax);
        uint256 expected = vaults.huntVaultOf(k);
        if (vaultId != expected) revert VaultMismatch(expected);
        t.exists = true;
        // forge-lint: disable-next-line(unsafe-typecast) zMin < zMax <= 2^84 (checked above)
        t.zMin = uint128(zMin);
        // forge-lint: disable-next-line(unsafe-typecast) zMax <= 2^84 (checked above)
        t.zMax = uint128(zMax);
        t.addedAt = uint64(block.timestamp);
        _targetList.push(k);
        emit TargetAdded(k, zMin, zMax, vaultId);
    }

    /// @notice Move the search band of an open target. Shares already counted stay counted.
    function setBand(uint16 k, uint256 zMin, uint256 zMax) external onlyGuardianOrDao {
        Target storage t = _targets[k];
        if (!t.exists) revert UnknownTarget(k);
        if (t.solved) revert TargetSolved(k);
        _checkBand(zMin, zMax);
        // forge-lint: disable-next-line(unsafe-typecast) zMin < zMax <= 2^84 (checked above)
        t.zMin = uint128(zMin);
        // forge-lint: disable-next-line(unsafe-typecast) zMax <= 2^84 (checked above)
        t.zMax = uint128(zMax);
        emit BandSet(k, zMin, zMax);
    }

    /// @notice Start a new season: share difficulty `bits` (a share is 1 in 2^bits survivors) and points per share.
    /// Shares hash the season id, so a new season needs shares mined for it.
    /// The guardian may start only the first season; every later one is a DAO vote.
    function startSeason(uint8 bits, uint64 pointsPerShare) external onlyGuardianOrDao {
        if (msg.sender != dao && season != 0) revert NotDao();
        if (bits > MAX_BITS || pointsPerShare == 0 || pointsPerShare > MAX_POINTS_PER_SHARE) revert BadSeason();
        uint32 id = season + 1;
        season = id;
        _seasons[id] = Season({bits: bits, pointsPerShare: pointsPerShare, startedAt: uint64(block.timestamp), shares: 0, miners: 0});
        emit SeasonStarted(id, bits, pointsPerShare);
    }

    /// @notice Stop or resume share submissions. Solution reveals are never paused.
    function pause(bool paused_) external onlyGuardianOrDao {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // =========================================================================================== mining

    /// @notice Submit shares for target k. Invalid shares revert the call (simulate first), duplicates are skipped,
    /// a call with nothing new reverts. Mints accepted x pointsPerShare MINING points. A candidate that is a real
    /// solution closes the target and pays the jackpot to the caller, even when its hash is above the target.
    function submitShares(uint16 k, int256[] calldata z, int256[] calldata d, uint256[] calldata r)
        external
        payable
        nonReentrant
        returns (uint256 accepted, uint256 skipped)
    {
        uint256 n = z.length;
        if (n == 0) revert EmptyBatch();
        if (n != d.length || n != r.length) revert LengthMismatch();
        if (n > MAX_BATCH) revert BatchTooLarge();
        if (paused) revert IsPaused();
        uint32 s = season;
        if (s == 0) revert NoSeason();
        Target storage t = _targets[k];
        if (!t.exists) revert UnknownTarget(k);
        if (t.solved) revert TargetSolved(k);
        Season storage se = _seasons[s];
        uint8 bits = se.bits;
        uint256 zMin = t.zMin;
        uint256 zMax = t.zMax;

        bool found;
        uint256 solIndex;
        for (uint256 i; i < n; ++i) {
            (uint8 reason, bool solution) = _evaluate(k, z[i], d[i], r[i], zMin, zMax);
            if (reason == OK && !_meets(_shareHash(k, z[i], d[i], r[i], msg.sender, s), bits)) reason = HASH;
            if (reason != OK && !(reason == HASH && solution)) revert InvalidShare(i, reason);
            bytes32 key = shareKey(k, z[i], d[i]);
            if (shareOwner[key] != address(0)) {
                ++skipped;
                continue;
            }
            shareOwner[key] = msg.sender;
            if (reason == OK) {
                ++accepted;
                emit Share(msg.sender, k, s, z[i], d[i], r[i]);
            }
            if (solution && !found) {
                found = true;
                solIndex = i;
            }
        }
        if (accepted == 0 && !found) revert NothingAccepted();

        uint256 pts;
        if (accepted > 0) {
            _record(t, se, s, k, accepted, bits);
            pts = accepted * se.pointsPerShare;
            points.mint(msg.sender, pts, MINING);
        }
        emit SharesSubmitted(msg.sender, k, s, accepted, skipped, pts);
        _collectFee(accepted);

        if (found) {
            int256 dd = d[solIndex];
            int256 rr = int256(r[solIndex]); // r < 2^127 here
            _jackpot(k, (dd + rr) / 2, (dd - rr) / 2, z[solIndex], msg.sender, false);
        }
    }

    /// @dev Takes shareFee per accepted share from msg.value for the BuyBurn and refunds the rest.
    function _collectFee(uint256 accepted) internal {
        uint256 fee = accepted * shareFee;
        if (msg.value < fee) revert FeeTooLow(fee);
        if (fee > 0) {
            totalFees += fee;
            (bool ok,) = buyBurn.call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
            emit FeePaid(msg.sender, fee);
        }
        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _record(Target storage t, Season storage se, uint32 s, uint16 k, uint256 accepted, uint8 bits) internal {
        uint256 w = accepted << bits;
        // forge-lint: disable-next-line(unsafe-typecast) accepted <= MAX_BATCH
        uint64 a = uint64(accepted);
        uint64 nowTs = uint64(block.timestamp);
        Miner storage m = _miners[msg.sender];
        if (m.shares == 0) {
            _minerList.push(msg.sender);
            m.firstShareAt = nowTs;
        }
        if (minerTargetShares[msg.sender][k] == 0) {
            t.miners += 1;
            m.targets += 1;
        }
        if (seasonMinerShares[s][msg.sender] == 0) se.miners += 1;
        m.shares += a;
        m.lastShareAt = nowTs;
        m.work += w;
        minerTargetShares[msg.sender][k] += a;
        seasonMinerShares[s][msg.sender] += a;
        t.shares += a;
        t.lastShareAt = nowTs;
        t.work += w;
        se.shares += a;
        totalShares += a;
        totalWork += w;
    }

    // =========================================================================================== jackpot

    /// @notice Commit to a solution before revealing it: c = solutionCommitment(k, x, y, z, msg.sender, salt).
    function commitSolution(bytes32 commitment) external {
        uint64 prev = solutionCommitAt[msg.sender][commitment];
        if (prev != 0 && block.timestamp <= prev + COMMIT_MAX_AGE) revert AlreadyCommitted();
        solutionCommitAt[msg.sender][commitment] = uint64(block.timestamp);
        emit SolutionCommitted(msg.sender, commitment);
    }

    /// @notice Reveal a committed solution of x^3 + y^3 + z^3 = k. The commit must be at least 60 s and at most
    /// 30 days old; |x|, |y|, |z| < 2^84. First valid one wins: the target closes, the triple and the finder are kept
    /// forever, the finder gets 1,000,000 DISCOVERY points and the target's prize vault is paid to the finder.
    function revealSolution(uint16 k, int256 x, int256 y, int256 z, bytes32 salt) external nonReentrant {
        bytes32 c = solutionCommitment(k, x, y, z, msg.sender, salt);
        uint256 t0 = solutionCommitAt[msg.sender][c];
        if (t0 == 0) revert NoCommit();
        if (block.timestamp < t0 + COMMIT_MIN_AGE) revert CommitTooNew();
        if (block.timestamp > t0 + COMMIT_MAX_AGE) revert CommitExpired();
        Target storage t = _targets[k];
        if (!t.exists) revert UnknownTarget(k);
        if (t.solved) revert TargetSolved(k);
        if (!_inRange(x) || !_inRange(y) || !_inRange(z)) revert CoordinateOutOfRange();
        if (x * x * x + y * y * y + z * z * z != int256(uint256(k))) revert NotASolution();
        delete solutionCommitAt[msg.sender][c];
        _jackpot(k, x, y, z, msg.sender, true);
    }

    /// @notice Anyone: retry paying a solved target's prize vault to its finder (only needed if the payout inside
    /// the discovery transaction failed, or the vault was created after the discovery).
    function payJackpot(uint16 k) external nonReentrant {
        Target storage t = _targets[k];
        if (!t.solved) revert TargetNotSolved(k);
        uint256 vid = vaults.huntVaultOf(k);
        if (vid == 0) revert NothingToPay();
        address finder = _solutions[k].finder;
        if (!vaults.releaseHunt(vid, finder)) revert NothingToPay();
        emit JackpotPaid(k, vid, finder, true);
    }

    function _jackpot(uint16 k, int256 x, int256 y, int256 z, address finder, bool viaReveal) internal {
        Target storage t = _targets[k];
        t.solved = true;
        solvedCount += 1;
        _solutions[k] = Solution({
            finder: finder,
            solvedAt: uint64(block.timestamp),
            season: season,
            viaReveal: viaReveal,
            x: x,
            y: y,
            z: z
        });
        emit Solved(k, finder, x, y, z, viaReveal);
        // the discovery stands even if Points refuses (for example the DAO removed this contract as a minter)
        try points.mint(finder, DISCOVERY_POINTS, DISCOVERY) {}
        catch {
            emit DiscoveryPointsFailed(k, finder);
        }
        uint256 vid = vaults.huntVaultOf(k);
        if (vid == 0) return;
        // the record above stands whatever the payout does; payJackpot retries a failed payout
        try vaults.releaseHunt(vid, finder) returns (bool paid) {
            emit JackpotPaid(k, vid, finder, paid);
        } catch (bytes memory err) {
            emit JackpotPayoutFailed(k, vid, err);
        }
    }

    // =========================================================================================== the check

    /// @notice Dedupe key of a candidate.
    function shareKey(uint16 k, int256 z, int256 d) public pure returns (bytes32) {
        return keccak256(abi.encode(k, z, d));
    }

    /// @notice The commitment revealSolution expects.
    function solutionCommitment(uint16 k, int256 x, int256 y, int256 z, address finder, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(k, x, y, z, finder, salt));
    }

    /// @notice Share hash for `miner` in season `s` (the current season is `season`).
    function shareHash(uint16 k, int256 z, int256 d, uint256 r, address miner, uint32 s) external view returns (bytes32) {
        return _shareHash(k, z, d, r, miner, s);
    }

    /// @notice Run the full share check for `miner` in the current season without submitting.
    /// @return reason 0 OK (a share), 1 ZERO, 2 BAND, 3 SIGN, 4 DBOUND, 5 DIVIDES, 6 MOD3, 7 NEGATIVE, 8 FILTER,
    /// 9 SQRT, 10 HASH (a survivor with a valid root whose hash is above the target)
    /// @return hash the share hash (zero unless the candidate got as far as the hash)
    /// @return solution true when the candidate is a solution of x^3 + y^3 + z^3 = k
    /// @return submitted true when the candidate was already counted (it would be skipped)
    function checkShare(uint16 k, int256 z, int256 d, uint256 r, address miner)
        external
        view
        returns (uint8 reason, bytes32 hash, bool solution, bool submitted)
    {
        Target storage t = _targets[k];
        if (!t.exists) revert UnknownTarget(k);
        (reason, solution) = _evaluate(k, z, d, r, t.zMin, t.zMax);
        if (reason == OK) {
            hash = _shareHash(k, z, d, r, miner, season);
            if (!_meets(hash, _seasons[season].bits)) reason = HASH;
        }
        submitted = shareOwner[shareKey(k, z, d)] != address(0);
    }

    function _evaluate(uint16 k, int256 z, int256 d, uint256 r, uint256 zMin, uint256 zMax)
        internal
        pure
        returns (uint8 reason, bool solution)
    {
        if (z == 0 || d == 0) return (ZERO, false);
        uint256 zAbs = _abs(z);
        if (zAbs < zMin || zAbs >= zMax) return (BAND, false);
        if ((z > 0) == (d > 0)) return (SIGN, false);
        // integer form of 3|d| <= |z|, written so that a huge d cannot overflow
        if (_abs(d) > zAbs / 3) return (DBOUND, false);
        // |z| < zMax <= 2^84 and |d| <= |z|/3, so nothing below can overflow int256
        int256 m = int256(uint256(k)) - z * z * z;
        if (m % d != 0) return (DIVIDES, false);
        int256 q = m / d;
        int256 nn = 4 * q - d * d;
        if (nn % 3 != 0) return (MOD3, false);
        int256 delta = nn / 3;
        if (delta < 0) return (NEGATIVE, false);
        // forge-lint: disable-next-line(unsafe-typecast) delta >= 0 (checked above)
        uint256 u = uint256(delta);
        if (!_survives(u)) return (FILTER, false);
        // u < 2^253, so a true root is below 2^127; a larger r is wrong and would overflow below
        if (r >= 1 << 127) return (SQRT, false);
        uint256 r2 = r * r;
        if (r2 > u || (r + 1) * (r + 1) <= u) return (SQRT, false);
        // forge-lint: disable-next-line(unsafe-typecast) r < 2^127 (checked above)
        solution = r2 == u && (d - int256(r)) % 2 == 0;
        return (OK, solution);
    }

    function _survives(uint256 u) internal pure returns (bool) {
        return (SQ64 >> (u & 63)) & 1 == 1 && (SQ7 >> (u % 7)) & 1 == 1 && (SQ11 >> (u % 11)) & 1 == 1
            && (SQ13 >> (u % 13)) & 1 == 1 && (SQ17 >> (u % 17)) & 1 == 1 && (SQ19 >> (u % 19)) & 1 == 1
            && (SQ23 >> (u % 23)) & 1 == 1 && (SQ29 >> (u % 29)) & 1 == 1 && (SQ31 >> (u % 31)) & 1 == 1;
    }

    function _shareHash(uint16 k, int256 z, int256 d, uint256 r, address miner, uint32 s) internal view returns (bytes32) {
        return keccak256(abi.encode(SHARE_TAG, block.chainid, address(this), k, z, d, r, miner, s));
    }

    function _meets(bytes32 h, uint8 bits) internal pure returns (bool) {
        // a shift by 256 yields 0, so bits == 0 accepts every hash
        return uint256(h) >> (256 - uint256(bits)) == 0;
    }

    function _abs(int256 v) internal pure returns (uint256) {
        unchecked {
            // forge-lint: disable-next-line(unsafe-typecast) two's complement magnitude, exact for every int256
            return v >= 0 ? uint256(v) : uint256(-(v + 1)) + 1;
        }
    }

    function _inRange(int256 v) internal pure returns (bool) {
        // forge-lint: disable-next-line(unsafe-typecast) MAX_COORD = 2^84 fits int256
        return v > -int256(MAX_COORD) && v < int256(MAX_COORD);
    }

    function _checkBand(uint256 zMin, uint256 zMax) internal pure {
        if (zMin == 0 || zMin >= zMax || zMax > MAX_COORD) revert BadBand();
    }

    // =========================================================================================== views

    /// @notice The filter moduli and their square bitmasks.
    function masks() external pure returns (uint256[9] memory moduli, uint256[9] memory bitmasks) {
        moduli = [uint256(64), 7, 11, 13, 17, 19, 23, 29, 31];
        bitmasks = [SQ64, SQ7, SQ11, SQ13, SQ17, SQ19, SQ23, SQ29, SQ31];
    }

    function targetCount() external view returns (uint256) {
        return _targetList.length;
    }

    /// @notice Every target k in the order added.
    function targetKs() external view returns (uint16[] memory) {
        return _targetList;
    }

    function targetInfo(uint16 k) public view returns (TargetView memory v) {
        Target storage t = _targets[k];
        Solution storage s = _solutions[k];
        v.k = k;
        v.exists = t.exists;
        v.solved = t.solved;
        v.zMin = t.zMin;
        v.zMax = t.zMax;
        v.shares = t.shares;
        v.miners = t.miners;
        v.lastShareAt = t.lastShareAt;
        v.addedAt = t.addedAt;
        v.work = t.work;
        v.vaultId = t.exists ? vaults.huntVaultOf(k) : 0;
        v.finder = s.finder;
        v.solvedAt = s.solvedAt;
        v.solvedSeason = s.season;
        v.viaReveal = s.viaReveal;
        v.x = s.x;
        v.y = s.y;
        v.z = s.z;
    }

    /// @notice targetInfo for every target, in the order added.
    function allTargets() external view returns (TargetView[] memory out) {
        out = new TargetView[](_targetList.length);
        for (uint256 i; i < out.length; i++) {
            out[i] = targetInfo(_targetList[i]);
        }
    }

    function seasonInfo(uint32 id) public view returns (SeasonView memory v) {
        Season storage s = _seasons[id];
        v = SeasonView({
            id: id,
            bits: s.bits,
            pointsPerShare: s.pointsPerShare,
            startedAt: s.startedAt,
            shares: s.shares,
            miners: s.miners
        });
    }

    function currentSeason() external view returns (SeasonView memory) {
        return seasonInfo(season);
    }

    function minerInfo(address miner) external view returns (MinerView memory v) {
        Miner storage m = _miners[miner];
        v = MinerView({
            shares: m.shares,
            seasonShares: seasonMinerShares[season][miner],
            firstShareAt: m.firstShareAt,
            lastShareAt: m.lastShareAt,
            targets: m.targets,
            work: m.work
        });
    }

    function minerCount() external view returns (uint256) {
        return _minerList.length;
    }

    /// @notice Miners in first-share order with their total shares and work.
    function miners(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, uint256[] memory shares, uint256[] memory work)
    {
        uint256 n = _minerList.length;
        if (offset >= n) return (new address[](0), new uint256[](0), new uint256[](0));
        uint256 end = limit > n - offset ? n : offset + limit;
        accounts = new address[](end - offset);
        shares = new uint256[](end - offset);
        work = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            address a = _minerList[i];
            accounts[i - offset] = a;
            shares[i - offset] = _miners[a].shares;
            work[i - offset] = _miners[a].work;
        }
    }

    /// @notice Landing-page totals.
    function stats()
        external
        view
        returns (
            uint256 shares,
            uint256 work,
            uint256 minerTotal,
            uint256 targets,
            uint256 solved,
            uint32 currentSeasonId,
            uint8 bits,
            uint256 pointsPerShare,
            bool isPaused
        )
    {
        Season storage s = _seasons[season];
        return (totalShares, totalWork, _minerList.length, _targetList.length, solvedCount, season, s.bits, s.pointsPerShare, paused);
    }
}
