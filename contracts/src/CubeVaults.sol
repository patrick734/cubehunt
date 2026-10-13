// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CubeRoles} from "./CubeRoles.sol";
import {AggregatorV3Interface, ICubePoints} from "./interfaces/ICube.sol";

/// @title CubeVaults
/// @dev Based on Ponmath's PonmathVaults (MIT). Changes: assets, price feeds and points per dollar are DAO-only
/// (USDG at $1 and ETH with its Chainlink feed are fixed at deploy, so the guardian can never price a token itself and
/// mint votes); a deposit fee on ETH and USDG goes to the $CUBE BuyBurn; guardian powers end at guardianUntil.
/// @notice Prize vaults. A HUNT vault belongs to one three-cubes target and only CubeHunt can pay it, when the
/// chain itself verified a solution. A PROOF vault belongs to a formal (Lean) statement: a claimant commits, submits
/// a proof hash and a link, attestors check it, and only the DAO timelock can release it after the review window.
///
/// Deposits are gifts: there is no withdrawal for depositors, no owner withdrawal and no sweep. Funds leave a vault
/// only through releaseHunt (CubeHunt), releaseClaim / moveVault / invest / divest (DAO timelock), and a payout
/// that a token refused is kept as owed to its recipient, who withdraws it later.
contract CubeVaults is CubeRoles, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 public constant HUNT = 0;
    uint8 public constant PROOF = 1;

    uint8 public constant OPEN = 0;
    uint8 public constant CLAIMED = 1;
    uint8 public constant MOVED = 2;

    uint8 public constant PENDING = 0;
    uint8 public constant RELEASED = 1;
    uint8 public constant REJECTED = 2;

    uint8 internal constant PATRON = 1;

    /// @notice A Chainlink answer older than this gives no points (stock feeds pause on weekends).
    uint256 public constant PRICE_MAX_AGE = 4 days;
    uint256 public constant COMMIT_MIN_AGE = 10 minutes;
    uint256 public constant COMMIT_MAX_AGE = 30 days;
    uint256 public constant MAX_ASSETS = 64;
    uint256 public constant MAX_POINTS_PER_USD = 1_000;
    /// @notice Highest deposit fee the DAO can set (10%).
    uint256 public constant MAX_DEPOSIT_FEE_BPS = 1_000;
    /// @notice Gas each token gets during a release; a token that needs more (or reverts) is recorded as owed.
    uint256 public constant TRANSFER_GAS = 300_000;
    uint256 public constant MAX_TITLE = 160;
    uint256 public constant MAX_REF = 512;
    uint256 public constant MAX_URI = 512;
    uint256 public constant MAX_NOTE = 512;
    /// @notice 1e18 = 1 USD in every USD amount this contract returns.
    uint256 public constant USD = 1e18;

    ICubePoints public immutable points;
    /// @notice USDG, counted at exactly $1. Immutable.
    address public immutable usdg;
    /// @notice Where deposit fees go: the $CUBE BuyBurn. Immutable.
    address public immutable buyBurn;
    /// @notice Share of each ETH or USDG deposit sent to the BuyBurn, in basis points.
    uint256 public depositFeeBps;
    /// @notice Review window between a claim's submission and the earliest release.
    uint256 public immutable reviewWindow;

    /// @notice CubeHunt, the only caller of releaseHunt. Set once by the guardian, afterwards only by the DAO.
    address public hunt;
    uint256 public pointsPerUsd = 100;
    uint256 public minAttestations = 1;
    uint256 public totalPatronUsd;

    struct Vault {
        uint8 kind;
        uint8 status;
        uint16 k;
        uint40 createdAt;
        uint40 closedAt;
        uint64 movedTo;
        uint64 releasedClaim;
        address paidTo;
        uint32 patronCount;
        uint32 depositCount;
        uint32 claimCount;
        string title;
        string ref;
    }

    struct Holding {
        uint256 held;
        uint256 deposited;
        uint256 paid;
        uint256 owed;
        bool listed;
    }

    struct Patron {
        uint128 usd;
        uint64 deposits;
    }

    struct VaultPatron {
        uint128 usd;
        bool listed;
    }

    struct Asset {
        bool listed;
        bool allowed;
        bool isUsd1;
        uint8 decimals;
        uint8 feedDecimals;
        address feed;
    }

    struct Claim {
        uint64 vaultId;
        uint8 status;
        uint16 passes;
        uint16 fails;
        uint40 submittedAt;
        uint40 reviewEnds;
        uint40 resolvedAt;
        address claimant;
        uint40 committedAt;
        bytes32 proofHash;
        string uri;
    }

    struct Attestation {
        address attestor;
        bool pass;
        uint64 at;
        string note;
    }

    struct VaultView {
        uint256 id;
        uint8 kind;
        uint8 status;
        uint16 k;
        uint256 createdAt;
        uint256 closedAt;
        uint256 movedTo;
        uint256 releasedClaim;
        address paidTo;
        uint256 patronCount;
        uint256 depositCount;
        uint256 claimCount;
        string title;
        string ref;
        address[] tokens;
        uint256[] held;
        uint256 usd;
        bool usdComplete;
    }

    struct HoldingView {
        address token;
        uint256 held;
        uint256 deposited;
        uint256 paid;
        uint256 owed;
    }

    struct AssetView {
        address token;
        bool allowed;
        bool isUsd1;
        uint8 decimals;
        address feed;
        uint8 feedDecimals;
        uint256 usdPerToken;
        bool priced;
    }

    struct ClaimView {
        uint256 id;
        uint256 vaultId;
        uint8 status;
        address claimant;
        bytes32 proofHash;
        string uri;
        uint256 committedAt;
        uint256 submittedAt;
        uint256 reviewEnds;
        uint256 resolvedAt;
        uint256 passes;
        uint256 fails;
        Attestation[] attestations;
    }

    Vault[] internal _vaults; // id = index + 1
    mapping(uint256 => address[]) internal _vaultTokens;
    mapping(uint256 => mapping(address => Holding)) internal _holdings;
    mapping(uint256 => address[]) internal _vaultPatrons;
    mapping(uint256 => mapping(address => VaultPatron)) internal _vaultPatronOf;
    mapping(uint256 => uint256[]) internal _vaultClaims;
    mapping(uint16 => uint256) internal _huntVaultOf;

    mapping(address => Asset) internal _assets;
    address[] internal _assetList;
    mapping(address => bool) public yieldVaultAllowed;
    address[] internal _yieldVaults;

    /// @dev USD value (1e18 = $1) each patron gave, priced at deposit time, and its deposit count.
    mapping(address => Patron) internal _patronOf;
    address[] internal _patrons;

    /// @notice Payouts a token refused, by recipient and token (address(0) = ETH). Withdraw with withdrawOwed.
    mapping(address => mapping(address => uint256)) public owed;
    mapping(address => uint256) public totalOwed;
    mapping(address => uint256) public totalHeld;

    Claim[] internal _claims; // id = index + 1
    mapping(uint256 => Attestation[]) internal _attestations;
    mapping(uint256 => mapping(address => bool)) public attested;
    mapping(address => bool) public isAttestor;
    address[] internal _attestorList;
    /// @notice Claim commitments: claimant => commitment => commit time.
    mapping(address => mapping(bytes32 => uint64)) public claimCommitAt;
    /// @dev Set by every deposit until the end of its transaction (EIP-1153). A payout in the same transaction
    /// reverts, so borrowed money (a flash loan) can never be deposited for PATRON points and paid straight back out
    /// by a release that the depositor receives.
    bool internal transient _depositedThisTx;

    event HuntSet(address indexed hunt);
    event VaultCreated(uint256 indexed vaultId, uint8 kind, uint16 indexed k, string title, string ref);
    event AssetSet(address indexed token, bool allowed, address feed, bool isUsd1, uint8 decimals, uint8 feedDecimals);
    event PointsPerUsdSet(uint256 pointsPerUsd);
    event MinAttestationsSet(uint256 minAttestations);
    event AttestorSet(address indexed attestor, bool allowed);
    event YieldVaultSet(address indexed erc4626, bool allowed);
    event Deposited(
        uint256 indexed vaultId,
        address indexed patron,
        address indexed token,
        uint256 amount,
        uint256 usd,
        uint256 points,
        bool priced
    );
    event Paid(uint256 indexed vaultId, address indexed to, address indexed token, uint256 amount);
    event Owed(uint256 indexed vaultId, address indexed to, address indexed token, uint256 amount);
    event OwedWithdrawn(address indexed account, address indexed token, address to, uint256 amount);
    event HuntReleased(uint256 indexed vaultId, address indexed finder);
    event ClaimCommitted(address indexed claimant, bytes32 indexed commitment);
    event ClaimSubmitted(
        uint256 indexed claimId, uint256 indexed vaultId, address indexed claimant, bytes32 proofHash, string uri, uint256 reviewEnds
    );
    event Attested(uint256 indexed claimId, address indexed attestor, bool pass, string note);
    event ClaimReleased(uint256 indexed claimId, uint256 indexed vaultId, address indexed claimant);
    event ClaimRejected(uint256 indexed claimId, uint256 indexed vaultId);
    event VaultMoved(uint256 indexed from, uint256 indexed to);
    event Invested(uint256 indexed vaultId, address indexed erc4626, uint256 assets, uint256 shares);
    event Divested(uint256 indexed vaultId, address indexed erc4626, uint256 shares, uint256 assets);
    event DepositFeeSet(uint256 bps);
    event DepositFee(uint256 indexed vaultId, address indexed token, uint256 amount);

    error NotHunt();
    error HuntAlreadySet();
    error UnknownVault(uint256 vaultId);
    error UnknownClaim(uint256 claimId);
    error VaultNotOpen(uint256 vaultId);
    error WrongKind();
    error BadVault();
    error HuntVaultExists(uint16 k);
    error AssetNotAllowed(address token);
    error BadAsset();
    error TooManyAssets();
    error ZeroAmount();
    error UseDepositETH();
    error BadValue();
    error AlreadyCommitted();
    error NoCommit();
    error CommitTooNew();
    error CommitExpired();
    error BadClaim();
    error NotAttestor();
    error AlreadyAttested();
    error ClaimNotPending();
    error ReviewNotOver();
    error NotEnoughAttestations();
    error NothingOwed();
    error NeedMoreGas();
    error YieldVaultNotAllowed(address erc4626);
    error InsufficientHeld();
    error DepositedThisTx();
    error FeeTransferFailed();

    /// @param ethUsdFeed_ Chainlink ETH/USD feed, or zero (ETH deposits then earn no points).
    constructor(
        address guardian_,
        address dao_,
        uint64 guardianUntil_,
        address points_,
        uint256 reviewWindow_,
        address usdg_,
        address ethUsdFeed_,
        address buyBurn_,
        uint256 depositFeeBps_
    ) CubeRoles(guardian_, dao_, guardianUntil_) {
        if (points_ == address(0) || usdg_ == address(0) || buyBurn_ == address(0)) revert ZeroAddress();
        if (reviewWindow_ < 60 || reviewWindow_ > 90 days || depositFeeBps_ > MAX_DEPOSIT_FEE_BPS) revert BadValue();
        points = ICubePoints(points_);
        reviewWindow = reviewWindow_;
        usdg = usdg_;
        buyBurn = buyBurn_;
        depositFeeBps = depositFeeBps_;
        emit DepositFeeSet(depositFeeBps_);
        // The two launch assets and their prices are fixed here; only a DAO vote can add or reprice an asset.
        _setAsset(address(0), true, ethUsdFeed_, false);
        _setAsset(usdg_, true, address(0), true);
    }

    /// @notice DAO only: deposit fee in basis points, at most MAX_DEPOSIT_FEE_BPS.
    function setDepositFeeBps(uint256 bps) external onlyDao {
        if (bps > MAX_DEPOSIT_FEE_BPS) revert BadValue();
        depositFeeBps = bps;
        emit DepositFeeSet(bps);
    }

    // =========================================================================================== guardian or DAO

    /// @notice Point the vaults at CubeHunt. The guardian can do it once; after that only the DAO.
    function setHunt(address hunt_) external {
        if (msg.sender != dao) {
            if (!_isGuardian(msg.sender)) revert NotGuardianOrDao();
            if (hunt != address(0)) revert HuntAlreadySet();
        }
        if (hunt_ == address(0)) revert ZeroAddress();
        hunt = hunt_;
        emit HuntSet(hunt_);
    }

    /// @notice Create a vault. HUNT: `k` is the three-cubes target (one open HUNT vault per k). PROOF: `k` is 0.
    function createVault(uint8 kind, uint16 k, string calldata title, string calldata ref)
        external
        onlyGuardianOrDao
        returns (uint256 id)
    {
        if (bytes(title).length == 0 || bytes(title).length > MAX_TITLE || bytes(ref).length > MAX_REF) revert BadVault();
        if (kind == HUNT) {
            if (k == 0) revert BadVault();
            uint256 cur = _huntVaultOf[k];
            if (cur != 0 && _vaults[cur - 1].status == OPEN) revert HuntVaultExists(k);
        } else if (kind == PROOF) {
            if (k != 0) revert BadVault();
        } else {
            revert WrongKind();
        }
        _vaults.push();
        id = _vaults.length;
        Vault storage v = _vaults[id - 1];
        v.kind = kind;
        v.k = k;
        v.createdAt = uint40(block.timestamp);
        v.title = title;
        v.ref = ref;
        if (kind == HUNT) _huntVaultOf[k] = id;
        emit VaultCreated(id, kind, k, title, ref);
    }

    /// @notice Allow or stop deposits of `token` (address(0) = ETH). `isUsd1` prices it at exactly 1 USD (USDG);
    /// otherwise `feed` is a Chainlink AggregatorV3 for token/USD (address(0) = no price, deposits earn no points).
    /// Token and feed decimals are read here.
    function setAsset(address token, bool allowed, address feed, bool isUsd1) external onlyDao {
        _setAsset(token, allowed, feed, isUsd1);
    }

    function _setAsset(address token, bool allowed, address feed, bool isUsd1) internal {
        if (isUsd1 && feed != address(0)) revert BadAsset();
        Asset storage a = _assets[token];
        uint8 dec = 18;
        if (token != address(0)) {
            if (token.code.length == 0) revert BadAsset();
            dec = IERC20Metadata(token).decimals();
        }
        uint8 fdec;
        if (feed != address(0)) {
            if (feed.code.length == 0) revert BadAsset();
            fdec = AggregatorV3Interface(feed).decimals();
        }
        if (dec > 36 || fdec > 36) revert BadAsset();
        if (!a.listed) {
            if (_assetList.length >= MAX_ASSETS) revert TooManyAssets();
            a.listed = true;
            _assetList.push(token);
        }
        a.allowed = allowed;
        a.isUsd1 = isUsd1;
        a.decimals = dec;
        a.feed = feed;
        a.feedDecimals = fdec;
        emit AssetSet(token, allowed, feed, isUsd1, dec, fdec);
    }

    /// @notice Points per 1 USD deposited (start 100), at most MAX_POINTS_PER_USD.
    function setPointsPerUsd(uint256 value) external onlyDao {
        if (value > MAX_POINTS_PER_USD) revert BadValue();
        pointsPerUsd = value;
        emit PointsPerUsdSet(value);
    }

    /// @notice Passing attestations a claim needs before the DAO can release it (at least 1).
    function setMinAttestations(uint256 value) external onlyGuardianOrDao {
        if (value == 0 || value > 100) revert BadValue();
        minAttestations = value;
        emit MinAttestationsSet(value);
    }

    function setAttestor(address attestor, bool allowed) external onlyGuardianOrDao {
        if (attestor == address(0)) revert ZeroAddress();
        if (allowed && !_inList(_attestorList, attestor)) _attestorList.push(attestor);
        isAttestor[attestor] = allowed;
        emit AttestorSet(attestor, allowed);
    }

    // =========================================================================================== deposits

    /// @notice Give `amount` of an allowlisted ERC20 to an open vault (approve first). The amount credited is what
    /// arrived (balance delta). Earns PATRON points for its USD value, or 0 when there is no fresh price.
    function deposit(uint256 vaultId, address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 received, uint256 pts)
    {
        if (token == address(0)) revert UseDepositETH();
        _openVault(vaultId);
        if (!_assets[token].allowed) revert AssetNotAllowed(token);
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        received -= _takeFee(vaultId, token, received);
        if (received == 0) revert ZeroAmount();
        pts = _credit(vaultId, token, received);
    }

    /// @notice Give ETH to an open vault.
    function depositETH(uint256 vaultId) external payable nonReentrant returns (uint256 pts) {
        _openVault(vaultId);
        if (!_assets[address(0)].allowed) revert AssetNotAllowed(address(0));
        if (msg.value == 0) revert ZeroAmount();
        uint256 net = msg.value - _takeFee(vaultId, address(0), msg.value);
        if (net == 0) revert ZeroAmount();
        pts = _credit(vaultId, address(0), net);
    }

    /// @dev Sends depositFeeBps of an ETH or USDG deposit to the BuyBurn. Other assets pay no fee.
    function _takeFee(uint256 vaultId, address token, uint256 amount) internal returns (uint256 fee) {
        if (token != address(0) && token != usdg) return 0;
        fee = (amount * depositFeeBps) / 10_000;
        if (fee == 0) return 0;
        if (token == address(0)) {
            (bool ok,) = buyBurn.call{value: fee}("");
            if (!ok) revert FeeTransferFailed();
        } else {
            IERC20(token).safeTransfer(buyBurn, fee);
        }
        emit DepositFee(vaultId, token, fee);
    }

    function _credit(uint256 vaultId, address token, uint256 amount) internal returns (uint256 pts) {
        Vault storage v = _vaults[vaultId - 1];
        Holding storage h = _holdings[vaultId][token];
        if (!h.listed) {
            h.listed = true;
            _vaultTokens[vaultId].push(token);
        }
        h.held += amount;
        h.deposited += amount;
        totalHeld[token] += amount;

        (uint256 usd, bool priced) = usdValue(token, amount);
        if (priced) pts = Math.mulDiv(usd, pointsPerUsd, USD);
        // usd < 2^120 (usdValue), so the 128-bit sums cannot overflow in practice
        Patron storage p = _patronOf[msg.sender];
        if (p.deposits == 0) _patrons.push(msg.sender);
        p.deposits += 1;
        // forge-lint: disable-next-line(unsafe-typecast) usd < 2^120 (usdValue)
        p.usd += uint128(usd);
        totalPatronUsd += usd;
        VaultPatron storage vp = _vaultPatronOf[vaultId][msg.sender];
        if (!vp.listed) {
            vp.listed = true;
            _vaultPatrons[vaultId].push(msg.sender);
            v.patronCount += 1;
        }
        // forge-lint: disable-next-line(unsafe-typecast) usd < 2^120 (usdValue)
        vp.usd += uint128(usd);
        v.depositCount += 1;
        _depositedThisTx = true;
        emit Deposited(vaultId, msg.sender, token, amount, usd, pts, priced);
        if (pts > 0) points.mint(msg.sender, pts, PATRON);
    }

    /// @notice USD value (1e18 = $1) of `amount` of `token` right now, and whether a fresh price exists.
    /// USD-pegged assets count as exactly 1 USD; others need a positive Chainlink answer at most 4 days old.
    /// Never reverts: anything odd counts as no price.
    function usdValue(address token, uint256 amount) public view returns (uint256 usd, bool priced) {
        Asset storage a = _assets[token];
        if (!a.listed || amount > type(uint96).max) return (0, false);
        if (a.isUsd1) {
            usd = Math.mulDiv(amount, USD, 10 ** a.decimals);
        } else {
            (uint256 price, bool ok) = _price(a);
            if (!ok) return (0, false);
            // price has feedDecimals; amount has decimals
            usd = Math.mulDiv(amount, price * USD, 10 ** (uint256(a.decimals) + a.feedDecimals));
        }
        // above 2^120 ($1.3e18) the number is nonsense, not a gift
        if (usd >= 1 << 120) return (0, false);
        priced = true;
    }

    /// @dev Fresh positive feed answer below 2^96; with amount below 2^96 the USD value always fits 256 bits.
    /// A low-level call, so a feed that reverts, runs out of its gas or answers malformed data means "no price".
    function _price(Asset storage a) internal view returns (uint256 price, bool ok) {
        address feed = a.feed;
        if (feed == address(0)) return (0, false);
        (bool success, bytes memory ret) =
            feed.staticcall{gas: 200_000}(abi.encodeCall(AggregatorV3Interface.latestRoundData, ()));
        if (!success || ret.length < 160) return (0, false);
        (, int256 answer,, uint256 updatedAt,) = abi.decode(ret, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || answer > int256(uint256(type(uint96).max))) return (0, false);
        if (updatedAt == 0 || updatedAt > block.timestamp || block.timestamp - updatedAt > PRICE_MAX_AGE) return (0, false);
        // forge-lint: disable-next-line(unsafe-typecast) answer > 0 (checked above)
        return (uint256(answer), true);
    }

    // =========================================================================================== HUNT release

    /// @notice CubeHunt only: pay every asset of a HUNT vault to the finder of a chain-verified solution.
    /// Returns false (and changes nothing) when the vault is not open any more.
    function releaseHunt(uint256 vaultId, address finder) external nonReentrant returns (bool) {
        if (msg.sender != hunt || hunt == address(0)) revert NotHunt();
        Vault storage v = _vault(vaultId);
        if (v.kind != HUNT) revert WrongKind();
        if (v.status != OPEN) return false;
        if (finder == address(0)) revert ZeroAddress();
        v.status = CLAIMED;
        v.paidTo = finder;
        v.closedAt = uint40(block.timestamp);
        emit HuntReleased(vaultId, finder);
        _payout(vaultId, finder);
        return true;
    }

    // =========================================================================================== PROOF claims

    /// @notice Step 1 of a claim: c = claimCommitment(vaultId, proofHash, msg.sender, salt).
    function commitClaim(uint256 vaultId, bytes32 commitment) external {
        _vault(vaultId);
        uint64 prev = claimCommitAt[msg.sender][commitment];
        if (prev != 0 && block.timestamp <= prev + COMMIT_MAX_AGE) revert AlreadyCommitted();
        claimCommitAt[msg.sender][commitment] = uint64(block.timestamp);
        emit ClaimCommitted(msg.sender, commitment);
    }

    /// @notice Step 2, 10 minutes to 30 days after the commit: reveal the proof hash and where the proof lives.
    /// Opens the review window. Returns the claim id.
    function submitClaim(uint256 vaultId, bytes32 proofHash, string calldata uri, bytes32 salt)
        external
        returns (uint256 claimId)
    {
        Vault storage v = _openVault(vaultId);
        if (v.kind != PROOF) revert WrongKind();
        if (proofHash == bytes32(0) || bytes(uri).length == 0 || bytes(uri).length > MAX_URI) revert BadClaim();
        bytes32 c = claimCommitment(vaultId, proofHash, msg.sender, salt);
        uint256 t0 = claimCommitAt[msg.sender][c];
        if (t0 == 0) revert NoCommit();
        if (block.timestamp < t0 + COMMIT_MIN_AGE) revert CommitTooNew();
        if (block.timestamp > t0 + COMMIT_MAX_AGE) revert CommitExpired();
        delete claimCommitAt[msg.sender][c];
        _claims.push();
        claimId = _claims.length;
        Claim storage cl = _claims[claimId - 1];
        // forge-lint: disable-next-line(unsafe-typecast) vault ids are array lengths
        cl.vaultId = uint64(vaultId);
        cl.claimant = msg.sender;
        // forge-lint: disable-next-line(unsafe-typecast) a timestamp, fits 40 bits
        cl.committedAt = uint40(t0);
        cl.proofHash = proofHash;
        cl.uri = uri;
        cl.submittedAt = uint40(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast) timestamps fit 40 bits until year 36812
        cl.reviewEnds = uint40(block.timestamp + reviewWindow);
        _vaultClaims[vaultId].push(claimId);
        v.claimCount += 1;
        emit ClaimSubmitted(claimId, vaultId, msg.sender, proofHash, uri, cl.reviewEnds);
    }

    /// @notice Attestors: record whether the proof checks against the exact formal statement. Once per attestor.
    function attest(uint256 claimId, bool pass, string calldata note) external {
        if (!isAttestor[msg.sender]) revert NotAttestor();
        Claim storage cl = _claim(claimId);
        if (cl.status != PENDING) revert ClaimNotPending();
        if (attested[claimId][msg.sender]) revert AlreadyAttested();
        if (bytes(note).length > MAX_NOTE) revert BadClaim();
        attested[claimId][msg.sender] = true;
        if (pass) cl.passes += 1;
        else cl.fails += 1;
        _attestations[claimId].push(Attestation({attestor: msg.sender, pass: pass, at: uint64(block.timestamp), note: note}));
        emit Attested(claimId, msg.sender, pass, note);
    }

    /// @notice DAO only: pay a PROOF vault to its claimant. Needs the review window over and at least
    /// minAttestations passing attestations.
    function releaseClaim(uint256 claimId) external onlyDao nonReentrant {
        Claim storage cl = _claim(claimId);
        if (cl.status != PENDING) revert ClaimNotPending();
        uint256 vaultId = cl.vaultId;
        Vault storage v = _vaults[vaultId - 1];
        if (v.status != OPEN) revert VaultNotOpen(vaultId);
        if (block.timestamp < cl.reviewEnds) revert ReviewNotOver();
        // a pass counts only while its attestor is still an attestor
        Attestation[] storage atts = _attestations[claimId];
        uint256 passes;
        for (uint256 i; i < atts.length; i++) {
            if (atts[i].pass && isAttestor[atts[i].attestor]) ++passes;
        }
        if (passes < minAttestations) revert NotEnoughAttestations();
        address to = cl.claimant;
        cl.status = RELEASED;
        cl.resolvedAt = uint40(block.timestamp);
        v.status = CLAIMED;
        v.paidTo = to;
        v.closedAt = uint40(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast) claim ids are array lengths
        v.releasedClaim = uint64(claimId);
        emit ClaimReleased(claimId, vaultId, to);
        _payout(vaultId, to);
    }

    /// @notice DAO only: reject a pending claim.
    function rejectClaim(uint256 claimId) external onlyDao {
        Claim storage cl = _claim(claimId);
        if (cl.status != PENDING) revert ClaimNotPending();
        cl.status = REJECTED;
        cl.resolvedAt = uint40(block.timestamp);
        emit ClaimRejected(claimId, cl.vaultId);
    }

    // =========================================================================================== DAO money moves

    /// @notice DAO only: move everything a vault holds into another open vault (the problem was solved elsewhere,
    /// or the formal statement was wrong). The source vault closes as MOVED.
    function moveVault(uint256 from, uint256 to) external onlyDao nonReentrant {
        Vault storage a = _openVault(from);
        _openVault(to);
        if (from == to) revert BadVault();
        address[] storage toks = _vaultTokens[from];
        for (uint256 i; i < toks.length; i++) {
            address token = toks[i];
            Holding storage hf = _holdings[from][token];
            uint256 amt = hf.held;
            if (amt == 0) continue;
            hf.held = 0;
            Holding storage ht = _holdings[to][token];
            if (!ht.listed) {
                ht.listed = true;
                _vaultTokens[to].push(token);
            }
            ht.held += amt;
        }
        a.status = MOVED;
        // forge-lint: disable-next-line(unsafe-typecast) vault ids are array lengths
        a.movedTo = uint64(to);
        a.closedAt = uint40(block.timestamp);
        emit VaultMoved(from, to);
    }

    /// @notice DAO only: allow an ERC-4626 vault for invest/divest. Its asset must be an allowlisted asset.
    function setYieldVault(address erc4626, bool allowed) external onlyDao {
        if (erc4626 == address(0) || erc4626.code.length == 0) revert BadAsset();
        address asset = IERC4626(erc4626).asset();
        if (allowed && !_assets[asset].allowed) revert AssetNotAllowed(asset);
        if (allowed && !_inList(_yieldVaults, erc4626)) _yieldVaults.push(erc4626);
        yieldVaultAllowed[erc4626] = allowed;
        emit YieldVaultSet(erc4626, allowed);
    }

    /// @notice DAO only: put `assets` of a vault's holding of the ERC-4626 asset (USDG) into the ERC-4626 vault.
    /// The share token is then held by the prize vault like any other asset.
    function invest(uint256 vaultId, address erc4626, uint256 amount) external onlyDao nonReentrant returns (uint256 shares) {
        _openVault(vaultId);
        if (!yieldVaultAllowed[erc4626]) revert YieldVaultNotAllowed(erc4626);
        if (amount == 0) revert ZeroAmount();
        address asset = IERC4626(erc4626).asset();
        Holding storage ha = _holdings[vaultId][asset];
        if (ha.held < amount) revert InsufficientHeld();
        ha.held -= amount;
        totalHeld[asset] -= amount;
        uint256 assetBefore = IERC20(asset).balanceOf(address(this));
        uint256 shareBefore = IERC20(erc4626).balanceOf(address(this));
        IERC20(asset).forceApprove(erc4626, amount);
        IERC4626(erc4626).deposit(amount, address(this));
        IERC20(asset).forceApprove(erc4626, 0);
        uint256 spent = assetBefore - IERC20(asset).balanceOf(address(this));
        shares = IERC20(erc4626).balanceOf(address(this)) - shareBefore;
        if (shares == 0 || spent > amount) revert BadValue();
        if (spent < amount) {
            ha.held += amount - spent;
            totalHeld[asset] += amount - spent;
        }
        Holding storage hs = _holdings[vaultId][erc4626];
        if (!hs.listed) {
            hs.listed = true;
            _vaultTokens[vaultId].push(erc4626);
        }
        hs.held += shares;
        totalHeld[erc4626] += shares;
        emit Invested(vaultId, erc4626, spent, shares);
    }

    /// @notice DAO only: redeem `shares` of an ERC-4626 position back into the vault's asset.
    function divest(uint256 vaultId, address erc4626, uint256 shares) external onlyDao nonReentrant returns (uint256 received) {
        _openVault(vaultId);
        if (shares == 0) revert ZeroAmount();
        Holding storage hs = _holdings[vaultId][erc4626];
        if (hs.held < shares) revert InsufficientHeld();
        hs.held -= shares;
        totalHeld[erc4626] -= shares;
        address asset = IERC4626(erc4626).asset();
        uint256 assetBefore = IERC20(asset).balanceOf(address(this));
        uint256 shareBefore = IERC20(erc4626).balanceOf(address(this));
        IERC4626(erc4626).redeem(shares, address(this), address(this));
        if (shareBefore - IERC20(erc4626).balanceOf(address(this)) != shares) revert BadValue();
        received = IERC20(asset).balanceOf(address(this)) - assetBefore;
        Holding storage ha = _holdings[vaultId][asset];
        if (!ha.listed) {
            ha.listed = true;
            _vaultTokens[vaultId].push(asset);
        }
        ha.held += received;
        totalHeld[asset] += received;
        emit Divested(vaultId, erc4626, shares, received);
    }

    // =========================================================================================== payouts

    /// @notice Withdraw a payout that a token refused during a release (for example a paused stock token).
    /// `to` = address(0) sends to the caller.
    function withdrawOwed(address token, address to) external nonReentrant {
        uint256 amt = owed[msg.sender][token];
        if (amt == 0) revert NothingOwed();
        if (to == address(0)) to = msg.sender;
        owed[msg.sender][token] = 0;
        totalOwed[token] -= amt;
        emit OwedWithdrawn(msg.sender, token, to, amt);
        if (token == address(0)) Address.sendValue(payable(to), amt);
        else IERC20(token).safeTransfer(to, amt);
    }

    /// @dev Send every asset a vault holds to `to`. Each token gets TRANSFER_GAS; a token that fails is recorded as
    /// owed to `to` so it never blocks the others. Callers are nonReentrant and set the vault's state first.
    function _payout(uint256 vaultId, address to) internal {
        if (_depositedThisTx) revert DepositedThisTx();
        address[] storage toks = _vaultTokens[vaultId];
        for (uint256 i; i < toks.length; i++) {
            address token = toks[i];
            Holding storage h = _holdings[vaultId][token];
            uint256 amt = h.held;
            if (amt == 0) continue;
            h.held = 0;
            totalHeld[token] -= amt;
            // enough gas for the full attempt, so a short gas limit cannot turn a good transfer into an IOU
            if (gasleft() < TRANSFER_GAS + TRANSFER_GAS / 63 + 100_000) revert NeedMoreGas();
            if (_trySend(token, to, amt)) {
                h.paid += amt;
                emit Paid(vaultId, to, token, amt);
            } else {
                h.owed += amt;
                owed[to][token] += amt;
                totalOwed[token] += amt;
                emit Owed(vaultId, to, token, amt);
            }
        }
    }

    /// @dev One capped transfer attempt that never reverts and never copies large return data.
    function _trySend(address token, address to, uint256 amt) internal returns (bool ok) {
        uint256 g = TRANSFER_GAS;
        if (token == address(0)) {
            assembly ("memory-safe") {
                ok := call(g, to, amt, 0, 0, 0, 0)
            }
            return ok;
        }
        bytes memory data = abi.encodeCall(IERC20.transfer, (to, amt));
        uint256 size;
        uint256 word;
        assembly ("memory-safe") {
            ok := call(g, token, 0, add(data, 0x20), mload(data), 0, 0x20)
            size := returndatasize()
            word := mload(0)
        }
        if (!ok) return false;
        return size == 0 ? token.code.length > 0 : (size >= 32 && word == 1);
    }

    // =========================================================================================== internals

    function _vault(uint256 vaultId) internal view returns (Vault storage) {
        if (vaultId == 0 || vaultId > _vaults.length) revert UnknownVault(vaultId);
        return _vaults[vaultId - 1];
    }

    function _openVault(uint256 vaultId) internal view returns (Vault storage v) {
        v = _vault(vaultId);
        if (v.status != OPEN) revert VaultNotOpen(vaultId);
    }

    function _claim(uint256 claimId) internal view returns (Claim storage) {
        if (claimId == 0 || claimId > _claims.length) revert UnknownClaim(claimId);
        return _claims[claimId - 1];
    }

    function _inList(address[] storage list, address a) internal view returns (bool) {
        for (uint256 i; i < list.length; i++) {
            if (list[i] == a) return true;
        }
        return false;
    }

    // =========================================================================================== views

    function claimCommitment(uint256 vaultId, bytes32 proofHash, address claimant, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(vaultId, proofHash, claimant, salt));
    }

    function vaultCount() external view returns (uint256) {
        return _vaults.length;
    }

    function huntVaultOf(uint16 k) external view returns (uint256) {
        return _huntVaultOf[k];
    }

    /// @notice Everything a page needs about one vault, with current holdings and their USD value
    /// (usdComplete is false when some held asset has no fresh price; those count 0 in usd).
    function vaultInfo(uint256 vaultId) public view returns (VaultView memory out) {
        Vault storage v = _vault(vaultId);
        out.id = vaultId;
        out.kind = v.kind;
        out.status = v.status;
        out.k = v.k;
        out.createdAt = v.createdAt;
        out.closedAt = v.closedAt;
        out.movedTo = v.movedTo;
        out.releasedClaim = v.releasedClaim;
        out.paidTo = v.paidTo;
        out.patronCount = v.patronCount;
        out.depositCount = v.depositCount;
        out.claimCount = v.claimCount;
        out.title = v.title;
        out.ref = v.ref;
        (out.tokens, out.held) = vaultAssets(vaultId);
        out.usdComplete = true;
        for (uint256 i; i < out.tokens.length; i++) {
            if (out.held[i] == 0) continue;
            (uint256 usd, bool priced) = usdValue(out.tokens[i], out.held[i]);
            if (priced) out.usd += usd;
            else out.usdComplete = false;
        }
    }

    /// @notice Tokens a vault has ever held (address(0) = ETH) and what it holds now.
    function vaultAssets(uint256 vaultId) public view returns (address[] memory tokens, uint256[] memory amounts) {
        _vault(vaultId);
        tokens = _vaultTokens[vaultId];
        amounts = new uint256[](tokens.length);
        for (uint256 i; i < tokens.length; i++) {
            amounts[i] = _holdings[vaultId][tokens[i]].held;
        }
    }

    /// @notice Per token: held now, deposited by patrons, paid out at release, and recorded as owed at release.
    function vaultHoldings(uint256 vaultId) external view returns (HoldingView[] memory out) {
        _vault(vaultId);
        address[] storage toks = _vaultTokens[vaultId];
        out = new HoldingView[](toks.length);
        for (uint256 i; i < toks.length; i++) {
            Holding storage h = _holdings[vaultId][toks[i]];
            out[i] = HoldingView({token: toks[i], held: h.held, deposited: h.deposited, paid: h.paid, owed: h.owed});
        }
    }

    /// @notice Patrons of a vault in first-deposit order with the USD value each gave to it.
    function vaultPatrons(uint256 vaultId, uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, uint256[] memory usd)
    {
        _vault(vaultId);
        address[] storage list = _vaultPatrons[vaultId];
        uint256 n = list.length;
        if (offset >= n) return (new address[](0), new uint256[](0));
        uint256 end = limit > n - offset ? n : offset + limit;
        accounts = new address[](end - offset);
        usd = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            accounts[i - offset] = list[i];
            usd[i - offset] = _vaultPatronOf[vaultId][list[i]].usd;
        }
    }

    function patronCount() external view returns (uint256) {
        return _patrons.length;
    }

    /// @notice All patrons in first-deposit order with their total USD given.
    function patrons(uint256 offset, uint256 limit) external view returns (address[] memory accounts, uint256[] memory usd) {
        uint256 n = _patrons.length;
        if (offset >= n) return (new address[](0), new uint256[](0));
        uint256 end = limit > n - offset ? n : offset + limit;
        accounts = new address[](end - offset);
        usd = new uint256[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            accounts[i - offset] = _patrons[i];
            usd[i - offset] = _patronOf[_patrons[i]].usd;
        }
    }

    /// @notice Every listed asset with its config and its current USD price per whole token (1e18 = $1).
    function assets() external view returns (AssetView[] memory out) {
        out = new AssetView[](_assetList.length);
        for (uint256 i; i < out.length; i++) {
            address t = _assetList[i];
            Asset storage a = _assets[t];
            (uint256 usd, bool priced) = usdValue(t, 10 ** a.decimals);
            out[i] = AssetView({
                token: t,
                allowed: a.allowed,
                isUsd1: a.isUsd1,
                decimals: a.decimals,
                feed: a.feed,
                feedDecimals: a.feedDecimals,
                usdPerToken: usd,
                priced: priced
            });
        }
    }

    function yieldVaults() external view returns (address[] memory list, bool[] memory allowed) {
        list = _yieldVaults;
        allowed = new bool[](list.length);
        for (uint256 i; i < list.length; i++) {
            allowed[i] = yieldVaultAllowed[list[i]];
        }
    }

    /// @notice What `account` can withdraw with withdrawOwed, over every listed asset and yield vault token.
    function owedOf(address account) external view returns (address[] memory tokens, uint256[] memory amounts) {
        uint256 n = _assetList.length + _yieldVaults.length;
        tokens = new address[](n);
        amounts = new uint256[](n);
        for (uint256 i; i < n; i++) {
            address t = i < _assetList.length ? _assetList[i] : _yieldVaults[i - _assetList.length];
            tokens[i] = t;
            amounts[i] = owed[account][t];
        }
    }

    /// @notice Dashboard numbers for a patron: total USD given, deposits made.
    function patronInfo(address account) external view returns (uint256 usd, uint256 deposits) {
        Patron storage p = _patronOf[account];
        return (p.usd, p.deposits);
    }

    /// @notice Total USD value (1e18 = $1) `account` gave, priced at deposit time.
    function patronUsd(address account) external view returns (uint256) {
        return _patronOf[account].usd;
    }

    /// @notice USD value `account` gave to one vault.
    function vaultPatronUsd(uint256 vaultId, address account) external view returns (uint256) {
        return _vaultPatronOf[vaultId][account].usd;
    }

    function attestors() external view returns (address[] memory list, bool[] memory active) {
        list = _attestorList;
        active = new bool[](list.length);
        for (uint256 i; i < list.length; i++) {
            active[i] = isAttestor[list[i]];
        }
    }

    function claimCount() external view returns (uint256) {
        return _claims.length;
    }

    /// @notice A claim with every attestation on it.
    function claimInfo(uint256 claimId) public view returns (ClaimView memory out) {
        Claim storage cl = _claim(claimId);
        out.id = claimId;
        out.vaultId = cl.vaultId;
        out.status = cl.status;
        out.claimant = cl.claimant;
        out.proofHash = cl.proofHash;
        out.uri = cl.uri;
        out.committedAt = cl.committedAt;
        out.submittedAt = cl.submittedAt;
        out.reviewEnds = cl.reviewEnds;
        out.resolvedAt = cl.resolvedAt;
        out.passes = cl.passes;
        out.fails = cl.fails;
        out.attestations = _attestations[claimId];
    }

    /// @notice Claim ids filed against a vault.
    function vaultClaims(uint256 vaultId) external view returns (uint256[] memory) {
        _vault(vaultId);
        return _vaultClaims[vaultId];
    }
}
