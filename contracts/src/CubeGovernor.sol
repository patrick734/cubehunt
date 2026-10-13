// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {GovernorStorage} from "@openzeppelin/contracts/governance/extensions/GovernorStorage.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";

/// @title CubeGovernor
/// @notice The CubeHunt DAO. Votes are CubeHunt Points (PTS, timestamp clock). Proposals are stored on chain with their
/// description, so a page can list and render them with eth_call alone. Everything passes the TimelockController.
contract CubeGovernor is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    GovernorStorage,
    GovernorVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl
{
    struct ProposalView {
        uint256 index;
        uint256 id;
        address proposer;
        uint8 state;
        uint256 snapshot;
        uint256 deadline;
        uint256 eta;
        uint256 againstVotes;
        uint256 forVotes;
        uint256 abstainVotes;
        uint256 quorum;
        string description;
        address[] targets;
        uint256[] values;
        bytes[] calldatas;
    }

    mapping(uint256 => string) internal _descriptions;
    /// @notice Number of proposals an account has voted on.
    mapping(address => uint256) public votesCastBy;

    constructor(
        IVotes token_,
        TimelockController timelock_,
        uint48 votingDelay_,
        uint32 votingPeriod_,
        uint256 proposalThreshold_
    )
        Governor("CubeGovernor")
        GovernorSettings(votingDelay_, votingPeriod_, proposalThreshold_)
        GovernorVotes(token_)
        GovernorVotesQuorumFraction(4)
        GovernorTimelockControl(timelock_)
    {}

    // ------------------------------------------------------------------------------------------------ views

    /// @notice The full description text of a proposal.
    function proposalDescription(uint256 proposalId) external view returns (string memory) {
        return _descriptions[proposalId];
    }

    /// @notice One call per proposal for the DAO page, by sequential index (0 .. proposalCount - 1).
    /// state: 0 Pending, 1 Active, 2 Canceled, 3 Defeated, 4 Succeeded, 5 Queued, 6 Expired, 7 Executed.
    function proposalAt(uint256 index) public view returns (ProposalView memory v) {
        uint256 id;
        (id, v.targets, v.values, v.calldatas,) = proposalDetailsAt(index);
        v.index = index;
        v.id = id;
        v.proposer = proposalProposer(id);
        v.state = uint8(state(id));
        v.snapshot = proposalSnapshot(id);
        v.deadline = proposalDeadline(id);
        v.eta = proposalEta(id);
        (v.againstVotes, v.forVotes, v.abstainVotes) = proposalVotes(id);
        v.quorum = v.snapshot < clock() ? quorum(v.snapshot) : 0;
        v.description = _descriptions[id];
    }

    /// @notice proposalAt for indexes offset .. offset+limit-1, newest last.
    function proposals(uint256 offset, uint256 limit) external view returns (ProposalView[] memory out) {
        uint256 n = proposalCount();
        if (offset >= n) return new ProposalView[](0);
        uint256 end = limit > n - offset ? n : offset + limit;
        out = new ProposalView[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            out[i - offset] = proposalAt(i);
        }
    }

    // ------------------------------------------------------------------------------------------------ hooks

    function _propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        address proposer
    ) internal override(Governor, GovernorStorage) returns (uint256 proposalId) {
        proposalId = super._propose(targets, values, calldatas, description, proposer);
        _descriptions[proposalId] = description;
    }

    function _castVote(uint256 proposalId, address account, uint8 support, string memory reason, bytes memory params)
        internal
        override
        returns (uint256)
    {
        uint256 weight = super._castVote(proposalId, account, support, reason, params);
        votesCastBy[account] += 1;
        return weight;
    }

    // ------------------------------------------------------------------------------------------------ required overrides

    function state(uint256 proposalId) public view override(Governor, GovernorTimelockControl) returns (ProposalState) {
        return super.state(proposalId);
    }

    function proposalNeedsQueuing(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (bool)
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
