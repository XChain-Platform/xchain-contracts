// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// treasury.js: poll-governed treasury with timelock and guardian veto
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. See the MIT
// License for the full text.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// A token community's treasury. Anyone can deposit; funds leave ONLY through a
// proposal that a binding VOTE poll has approved, and even then only after a
// timelock every holder can see coming. This is the safe-by-default answer to
// the low-turnout governance raid (BonkDAO, July 2026: $4.4M of freshly bought
// tokens passed a $20M treasury transfer with 7 wallets voting, and the
// transfer executed the moment the vote closed). Four stacked defenses:
//
//   1. Proposal gate - only holders of the governance token can propose.
//   2. Poll binding  - in 'guardian' mode (the recommended posture) each poll
//                      must be bound to its proposal by the guardian BEFORE it
//                      finalizes; a hostile look-alike poll can never arm.
//   3. Timelock      - an armed proposal waits `timelockBlocks` before it can
//                      execute; the pending transfer is public contract state.
//   4. Guardian veto - the guardian can kill a proposal any time before it
//                      executes.
//
// WHY THE GUARDIAN EXISTS (read before choosing 'open' mode)
//
// The VOTE finalization callback tells this contract THAT a poll passed, but
// the protocol does not tell the contract WHICH token voted: neither the
// callback arguments nor xchain.getPollResult carry the poll's TICK. Anyone
// can create a poll over a worthless token they fully control, point its
// CALLBACK_CONTRACT at this treasury, and "pass" it unanimously. In 'guardian'
// mode that poll is inert, because only a poll the guardian has verified
// off-chain (right electorate token, real QUORUM / MIN_VOTERS, option 0 =
// approve) and bound via approvePoll() can arm its proposal. In 'open' mode
// any passing poll that names a live proposal arms it, and the timelock plus
// veto window is the ONLY barrier left. Choose 'open' only with an actively
// watching guardian and holders who will see the pending transfer in time.
//
// POLL CONVENTIONS (the poll creator must follow these)
//
//   - options[0] is the approval option ("approve"); arm() rejects any other
//     winner, so "reject" polls and multi-option polls cannot move funds.
//   - Set QUORUM and MIN_VOTERS on the poll. The protocol reports both gates
//     as met when they were never configured, so arm()'s gate check cannot
//     tell "met" from "absent"; the guardian verifies them before binding.
//   - CALLBACK_CONTRACT = this contract's deploy action index,
//     CALLBACK_METHOD = "arm", CALLBACK_PARAMS = [proposalId],
//     CALLBACK_ON = "pass" (the default), and a GAS_ESCROW that covers
//     arm()'s execution.
//
// CUSTODY MODEL
//
// XChain has no msg.value. Fund the treasury with plain DEPOSIT actions to the
// contract's address: any tick, any amount, any time, no method call needed.
// Every armed proposal names an exact (recipient, tick, amount); execution
// sends exactly that and nothing else.
// ---------------------------------------------------------------------------

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        propose:         { summary: 'Governance-token holder records a spend proposal (recipient, tick, amount, memo)', params: ['recipient', 'tick', 'amount', 'memo'] },
        approvePoll:     { summary: 'Guardian binds a verified poll to a proposal (guardian mode only)', params: ['proposalId', 'pollIndex'] },
        arm:             { summary: 'Poll finalization callback: arms the proposal and starts the timelock (set as the binding poll\'s CALLBACK_METHOD; not user-callable)', params: [] },
        veto:            { summary: 'Guardian kills a proposed or armed proposal', params: ['proposalId'] },
        cancel:          { summary: 'Proposer withdraws their own not-yet-armed proposal', params: ['proposalId'] },
        executeProposal: { summary: 'Anyone executes an armed proposal after the timelock, inside the execution window', params: ['proposalId'] },
        info:            { summary: 'Read the treasury configuration and proposal count', params: [], view: true },
        proposalInfo:    { summary: 'Read one proposal, with EXPIRED derived for a stale armed proposal', params: ['proposalId'], view: true }
    } },

    // initialize(guardian, govTick, timelockBlocks, executeWindowBlocks,
    //            minProposeBalance, mode)
    // `mode` is 'guardian' (polls must be bound via approvePoll before they can
    // arm) or 'open' (any passing poll naming a live proposal arms it).
    initialize: function (xchain) {
        var guardian = xchain.getInputParam(0);
        var govTick  = xchain.getInputParam(1);
        var timelock = parseInt(xchain.getInputParam(2));
        var window   = parseInt(xchain.getInputParam(3));
        var minProp  = xchain.getInputParam(4);
        var mode     = xchain.getInputParam(5);

        xchain.require(guardian, 'guardian required');
        xchain.require(govTick, 'govTick required');
        xchain.require(timelock > 0, 'timelockBlocks must be a positive integer');
        xchain.require(window > 0, 'executeWindowBlocks must be a positive integer');
        xchain.require(minProp && xchain.math.gt(minProp, '0'),
            'minProposeBalance must be positive');
        xchain.require(mode === 'guardian' || mode === 'open',
            'mode must be "guardian" or "open"');

        xchain.state.set('guardian', guardian);
        xchain.state.set('gov_tick', govTick);
        xchain.state.set('timelock', String(timelock));
        xchain.state.set('exec_window', String(window));
        xchain.state.set('min_propose', minProp);
        xchain.state.set('mode', mode);
        xchain.state.set('proposal_count', '0');
    },

    // propose(recipient, tick, amount, memo): record a spend proposal. Gated on
    // the caller's governance-token balance so outsiders (and the treasury's own
    // callback identity) cannot fill the queue. Inert until a poll arms it.
    propose: function (xchain) {
        var recipient = xchain.getInputParam(0);
        var tick      = xchain.getInputParam(1);
        var amount    = xchain.getInputParam(2);
        var memo      = xchain.getInputParam(3) || '';
        var caller    = xchain.getSourceAddress();

        xchain.require(caller !== xchain.getContractAddress(), 'contract cannot propose');
        xchain.require(recipient, 'recipient required');
        xchain.require(tick, 'tick required');
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');

        var held = xchain.getBalance(caller, xchain.state.get('gov_tick')) || '0';
        xchain.require(xchain.math.gte(held, xchain.state.get('min_propose')),
            'insufficient governance holdings to propose');

        var id = String(parseInt(xchain.state.get('proposal_count')) + 1);
        xchain.state.set('proposal_count', id);
        saveProposal(xchain, id, {
            proposer:  caller,
            recipient: recipient,
            tick:      tick,
            amount:    amount,
            memo:      memo,
            status:    'PROPOSED',
            created:   xchain.getBlockHeight(),
            expected_poll: null,
            poll:      null,
            armed:     null
        });
        return id;
    },

    // approvePoll(proposalId, pollIndex): guardian mode's fail-closed step. The
    // guardian verifies the poll off-chain (electorate token, quorum gates,
    // option order) and binds its index here; arm() then accepts only that poll.
    approvePoll: function (xchain) {
        var id   = xchain.getInputParam(0);
        var poll = xchain.getInputParam(1);

        xchain.require(xchain.state.get('mode') === 'guardian',
            'poll approval is only used in guardian mode');
        xchain.require(xchain.getSourceAddress() === xchain.state.get('guardian'),
            'only the guardian can approve a poll');
        xchain.require(poll && xchain.math.gt(poll, '0'), 'pollIndex required');

        var rec = loadProposal(xchain, id);
        xchain.require(rec.status === 'PROPOSED', 'proposal is not awaiting a poll');
        rec.expected_poll = String(poll);
        saveProposal(xchain, id, rec);
    },

    // arm(pollIndex, status, winningOption, totalWeight, totalVoters, quorumMet,
    //     minVotersMet, proposalId): the VOTE finalization callback (Section 14
    //     of the VOTE spec). The injected EXECUTE's SOURCE is this contract's own
    //     address, which no user action and no other contract's emit.execute can
    //     present, so the caller check pins this method to poll finalizations.
    arm: function (xchain) {
        xchain.require(xchain.getSourceAddress() === xchain.getContractAddress(),
            'arm is only callable by a poll finalization callback');

        var pollIndex = xchain.getInputParam(0);
        var status    = xchain.getInputParam(1);
        var winning   = xchain.getInputParam(2);
        var weight    = xchain.getInputParam(3);
        var voters    = xchain.getInputParam(4);
        var quorumMet = xchain.getInputParam(5);
        var minVoters = xchain.getInputParam(6);
        var id        = xchain.getInputParam(7);

        xchain.require(status === 'finalized', 'poll did not finalize with a result');
        xchain.require(winning === '0', 'poll winner is not the approval option');
        xchain.require(quorumMet === '1' && minVoters === '1', 'poll gates not met');

        var rec = loadProposal(xchain, id);
        xchain.require(rec.status === 'PROPOSED', 'proposal is not awaiting a poll');
        if (xchain.state.get('mode') === 'guardian')
            xchain.require(rec.expected_poll === String(pollIndex),
                'poll is not the guardian-approved poll for this proposal');

        rec.status = 'ARMED';
        rec.poll   = String(pollIndex);
        rec.armed  = xchain.getBlockHeight();
        rec.weight = weight;
        rec.voters = voters;
        saveProposal(xchain, id, rec);
    },

    // veto(proposalId): the guardian's kill switch, usable at any point before
    // execution. This window (timelock + execution window) is the last defense
    // in 'open' mode and the second-to-last in 'guardian' mode.
    veto: function (xchain) {
        xchain.require(xchain.getSourceAddress() === xchain.state.get('guardian'),
            'only the guardian can veto');
        var id  = xchain.getInputParam(0);
        var rec = loadProposal(xchain, id);
        xchain.require(rec.status === 'PROPOSED' || rec.status === 'ARMED',
            'proposal is not vetoable');
        rec.status = 'VETOED';
        rec.vetoed = xchain.getBlockHeight();
        saveProposal(xchain, id, rec);
    },

    // cancel(proposalId): the proposer withdraws a proposal no poll has armed.
    cancel: function (xchain) {
        var id  = xchain.getInputParam(0);
        var rec = loadProposal(xchain, id);
        xchain.require(xchain.getSourceAddress() === rec.proposer,
            'only the proposer can cancel');
        xchain.require(rec.status === 'PROPOSED', 'only an un-armed proposal can be cancelled');
        rec.status = 'CANCELLED';
        saveProposal(xchain, id, rec);
    },

    // executeProposal(proposalId): anyone fires an armed proposal once the
    // timelock has elapsed, inside the execution window. Re-verifies the poll
    // through xchain.getPollResult, which only exposes polls finalized in an
    // earlier block; the timelock guarantees we are past that horizon, so an
    // armed state that a reorg re-wrote cannot pay out against a vanished poll.
    executeProposal: function (xchain) {
        var id  = xchain.getInputParam(0);
        var rec = loadProposal(xchain, id);
        xchain.require(rec.status === 'ARMED', 'proposal is not armed');

        var height = xchain.getBlockHeight();
        var ready  = rec.armed + parseInt(xchain.state.get('timelock'));
        xchain.require(height >= ready, 'timelock has not elapsed');
        xchain.require(height <= ready + parseInt(xchain.state.get('exec_window')),
            'execution window has passed');

        var poll = xchain.getPollResult(rec.poll);
        xchain.require(poll !== null && poll.status === 'finalized' &&
            String(poll.winning_option) === '0', 'poll result not verifiable on-chain');

        var held = xchain.getBalance(xchain.getContractAddress(), rec.tick) || '0';
        xchain.require(xchain.math.gte(held, rec.amount), 'insufficient treasury balance');

        // State guard: EXECUTED is committed in the same atomic scope as the
        // send, so a second executeProposal can never double-pay.
        rec.status   = 'EXECUTED';
        rec.executed = height;
        saveProposal(xchain, id, rec);

        xchain.emit.send({
            destination: rec.recipient,
            tick:        rec.tick,
            quantity:    rec.amount
        });
        return rec.amount;
    },

    info: function (xchain) {
        return JSON.stringify({
            mode:       xchain.state.get('mode'),
            guardian:   xchain.state.get('guardian'),
            govTick:    xchain.state.get('gov_tick'),
            timelock:   xchain.state.get('timelock'),
            execWindow: xchain.state.get('exec_window'),
            minPropose: xchain.state.get('min_propose'),
            proposals:  xchain.state.get('proposal_count')
        });
    },

    // proposalInfo(proposalId): one proposal, with EXPIRED derived (an armed
    // proposal whose execution window has passed can never execute; no state
    // transition is needed to make that true).
    proposalInfo: function (xchain) {
        var id = xchain.getInputParam(0);
        xchain.require(id, 'proposalId required');
        var rec = loadProposal(xchain, id);
        if (rec.status === 'ARMED') {
            var deadline = rec.armed + parseInt(xchain.state.get('timelock')) +
                           parseInt(xchain.state.get('exec_window'));
            if (xchain.getBlockHeight() > deadline) rec.status = 'EXPIRED';
        }
        return JSON.stringify(rec);
    }
};

function loadProposal(xchain, id) {
    xchain.require(id && xchain.math.gt(id, '0') &&
        xchain.math.lte(id, xchain.state.get('proposal_count')), 'unknown proposal');
    return JSON.parse(xchain.state.get('proposal:' + parseInt(id)));
}

function saveProposal(xchain, id, rec) {
    xchain.state.set('proposal:' + parseInt(id), JSON.stringify(rec));
}
