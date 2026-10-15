// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// treasury_test/invariants.js: seeded invariant tests for treasury.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Harness assumptions this suite relies on:
//   - the VOTE finalization callback is modelled as an EXECUTE of arm() whose
//     caller is the contract's own address (the identity the indexer presents);
//   - xchain.getPollResult reads h.ledger.polls, seeded per test in the shape the
//     VM suite's passedPoll() uses;
//   - getBlockHeight is a JS number, as in the VM E2E harness.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng, bn } = require('../../test/inproc/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'treasury.js'), 'utf8');
const ADDR = 'C:BTC:1';
const GOV = 'GOV';
const PAY = 'PAY';
const GUARDIAN = 'guardian';
const HOLDER = 'holder';
const HOLDER2 = 'holder2';
const SMALL = 'small';          // holds one base unit less than minProposeBalance
const ATTACKER = 'attacker';
const PAYEE = 'payee';
const TIMELOCK = 10;
const WINDOW = 20;
const MIN_PROPOSE = '100';
const POLL = '501';

function passedPoll(extra) {
    return Object.assign({ status: 'finalized', winning_option: 0, total_weight: '4000', total_voters: 12,
        decided_early: false, tick: GOV, options: [{ index: 0, weight: '4000', voters: 12 }] }, extra || {});
}

function setup(mode, opts) {
    const o = opts || {};
    const h = new Harness();
    h.seedBalance(HOLDER, GOV, '1000');
    h.seedBalance(HOLDER2, GOV, MIN_PROPOSE);
    h.seedBalance(SMALL, GOV, '99.99999999');
    h.seedBalance(HOLDER, PAY, o.payBalance || '5000');
    h.ledger.setTokenDecimals(PAY, o.payDecimals === undefined ? 8 : o.payDecimals);
    const r = h.deploy({ code: CODE, deployer: GUARDIAN, contractAddress: ADDR,
        params: [GUARDIAN, GOV, String(TIMELOCK), String(WINDOW), MIN_PROPOSE, mode || 'guardian'] });
    assert.ok(r.success, r.error);
    return h;
}

function call(h, method, params, caller) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller });
}

function armArgs(id, o) {
    const x = o || {};
    return [x.poll || POLL, 'finalized', x.winning || '0', '4000', '12', '1', '1', x.tick || GOV, id];
}

function rec(h, id) { return JSON.parse(h.state(ADDR, 'proposal:' + id)); }

// propose, bind (guardian mode), arm, fund; returns the harness at the arming height.
function armed(mode, amount, opts) {
    const h = setup(mode, opts);
    const p = call(h, 'propose', [PAYEE, PAY, amount || '400', 'm'], HOLDER);
    assert.ok(p.success, p.error);
    if ((mode || 'guardian') === 'guardian') assert.ok(call(h, 'approvePoll', ['1', POLL], GUARDIAN).success);
    const a = call(h, 'arm', armArgs('1'), ADDR);
    assert.ok(a.success, a.error);
    return h;
}

(available ? describe : describe.skip)('treasury invariants (in-process)', function () {

    it('conservation, single payout and authorization across seeded random call sequences', function () {
        const ACTORS = [GUARDIAN, HOLDER, HOLDER2, SMALL, ATTACKER, ADDR];
        const METHODS = ['propose', 'propose', 'approvePoll', 'approvePoll', 'arm', 'arm', 'arm', 'veto', 'cancel',
            'executeProposal', 'executeProposal', 'executeProposal'];
        const hits = { executeProposal: 0, arm: 0, veto: 0, cancel: 0, refusedExecute: 0 };
        for (let seed = 1; seed <= 120; seed++) {
            const R = rng(seed);
            const mode = seed % 2 ? 'guardian' : 'open';
            const h = setup(mode);
            const supply = h.ledger.total(PAY);
            const govSupply = h.ledger.total(GOV);
            const paidPerProposal = {};
            let paidSum = bn('0');
            for (let step = 0; step < 40; step++) {
                if (R.next() < 0.3) h.deposit(HOLDER, ADDR, PAY, String(R.int(1, 300)));
                if (R.next() < 0.5) h.mineBlock(R.int(1, 4));
                const pollId = String(R.int(501, 503));
                if (R.next() < 0.3) {
                    const kind = R.int(0, 5);
                    h.ledger.polls[pollId] = kind <= 2 ? passedPoll()
                        : kind === 3 ? passedPoll({ options: [{ index: 0, weight: '10' }, { index: 1, weight: '10' }] })
                            : kind === 4 ? passedPoll({ tick: 'JUNK' }) : passedPoll({ winning_option: 1 });
                }
                const count = parseInt(h.state(ADDR, 'proposal_count'), 10);
                const method = R.pick(METHODS);
                // Bias each method toward its authorised caller, keeping a share of wrong callers.
                const rightful = { arm: ADDR, approvePoll: GUARDIAN, veto: GUARDIAN, propose: HOLDER };
                const caller = rightful[method] && R.next() < 0.7 ? rightful[method] : R.pick(ACTORS);
                // Bias executeProposal toward a currently ARMED proposal so payouts are reached.
                let id = String(R.int(1, Math.max(1, count + 1)));
                if (method === 'executeProposal' && R.next() < 0.8) {
                    const armedIds = [];
                    for (let i = 1; i <= count; i++) if (rec(h, String(i)).status === 'ARMED') armedIds.push(String(i));
                    if (armedIds.length) id = R.pick(armedIds);
                }
                let params;
                if (method === 'propose') params = [PAYEE, PAY, String(R.int(1, 400)) + (R.next() < 0.3 ? '.123456789' : ''), 'm'];
                else if (method === 'approvePoll') params = [id, pollId];
                else if (method === 'arm') params = armArgs(id, { poll: pollId, tick: R.next() < 0.1 ? 'JUNK' : GOV });
                else params = [id];
                const before = id <= count ? rec(h, id) : null;
                const r = call(h, method, params, caller);
                const where = 'seed ' + seed + ' step ' + step + ' ' + method + ' by ' + caller;
                if (r.success && hits[method] !== undefined) hits[method]++;
                if (!r.success && method === 'executeProposal' && before && before.status === 'ARMED') hits.refusedExecute++;
                if (r.success) {
                    if (method === 'approvePoll' || method === 'veto') assert.strictEqual(caller, GUARDIAN, where);
                    if (method === 'arm') assert.strictEqual(caller, ADDR, where);
                    if (method === 'cancel') assert.strictEqual(caller, before.proposer, where);
                    if (method === 'propose') assert.ok([HOLDER, HOLDER2].indexOf(caller) >= 0, where);
                    if (method === 'approvePoll') assert.strictEqual(mode, 'guardian', where);
                    if (method === 'arm' && mode === 'guardian') assert.strictEqual(before.expected_poll, pollId, where);
                    if (method === 'executeProposal') {
                        assert.strictEqual(before.status, 'ARMED', where);
                        const height = h.ledger.blockHeight;
                        assert.ok(height >= before.armed + TIMELOCK && height <= before.armed + TIMELOCK + WINDOW, where + ' outside window');
                        const sends = r.actions.filter((a) => a.action === 'SEND');
                        assert.strictEqual(sends.length, 1, where);
                        assert.ok(bn(sends[0].settled).lte(bn(before.amount)), where + ' paid above mandate');
                        assert.strictEqual(sends[0].params.destination, before.recipient, where);
                        paidPerProposal[id] = (paidPerProposal[id] || 0) + 1;
                        paidSum = paidSum.plus(bn(sends[0].settled));
                    } else {
                        assert.strictEqual(r.actions.length, 0, where + ' emitted from a non-execute method');
                    }
                }
                assert.strictEqual(h.ledger.total(PAY), supply, where + ': PAY supply drift');
                assert.strictEqual(h.ledger.total(GOV), govSupply, where + ': GOV supply drift');
            }
            for (const k of Object.keys(paidPerProposal)) assert.strictEqual(paidPerProposal[k], 1, 'seed ' + seed + ' proposal ' + k + ' paid twice');
            const count = parseInt(h.state(ADDR, 'proposal_count'), 10);
            let recorded = bn('0');
            for (let i = 1; i <= count; i++) {
                const p = rec(h, String(i));
                if (p.status === 'EXECUTED') recorded = recorded.plus(bn(p.paid));
                else assert.ok(!paidPerProposal[String(i)], 'seed ' + seed + ' paid but not EXECUTED');
            }
            assert.ok(recorded.eq(paidSum), 'seed ' + seed + ': rec.paid total ' + recorded + ' != SENT ' + paidSum);
            assert.ok(bn(h.ledger.getBalance(PAYEE, PAY)).eq(paidSum), 'seed ' + seed + ': payee balance != paid');
        }
        for (const k of Object.keys(hits)) assert.ok(hits[k] >= 20, 'the run rarely reached ' + k + ': ' + JSON.stringify(hits));
    });

    it('determinism: the same seeded sequence yields byte-identical state', function () {
        function runOnce() {
            const R = rng(7);
            const h = setup('open');
            for (let i = 0; i < 30; i++) {
                h.deposit(HOLDER, ADDR, PAY, '10');
                h.ledger.polls[POLL] = passedPoll();
                call(h, R.pick(['propose', 'arm', 'executeProposal', 'veto']),
                    R.next() < 0.5 ? [PAYEE, PAY, '5', 'm'] : (R.next() < 0.5 ? armArgs('1') : ['1']), R.pick([HOLDER, ADDR, GUARDIAN]));
                h.mineBlock(R.int(1, 8));
            }
            return JSON.stringify(h.ledger.snapshot());
        }
        assert.strictEqual(runOnce(), runOnce());
    });

    it('double execution: a second executeProposal reverts and pays nothing', function () {
        const h = armed('guardian');
        h.deposit(HOLDER, ADDR, PAY, '1000');
        h.ledger.polls[POLL] = passedPoll();
        h.mineBlock(TIMELOCK);
        const r1 = call(h, 'executeProposal', ['1'], ATTACKER);
        assert.ok(r1.success, r1.error);
        const r2 = call(h, 'executeProposal', ['1'], ATTACKER);
        assert.ok(!r2.success);
        assert.match(r2.error, /not armed/);
        for (const m of ['veto', 'cancel']) assert.ok(!call(h, m, ['1'], m === 'veto' ? GUARDIAN : HOLDER).success, m);
        assert.ok(!call(h, 'arm', armArgs('1'), ADDR).success, 're-arm after execute');
        assert.strictEqual(h.ledger.getBalance(PAYEE, PAY), '400');
        assert.strictEqual(h.ledger.getBalance(ADDR, PAY), '600');
    });

    it('timelock and window boundaries are exact', function () {
        const h = armed('open');
        h.deposit(HOLDER, ADDR, PAY, '1000');
        h.ledger.polls[POLL] = passedPoll();
        const armedAt = rec(h, '1').armed;
        h.ledger.blockHeight = armedAt + TIMELOCK - 1;
        assert.match(call(h, 'executeProposal', ['1'], ATTACKER).error, /timelock/);
        h.ledger.blockHeight = armedAt + TIMELOCK + WINDOW + 1;
        assert.match(call(h, 'executeProposal', ['1'], ATTACKER).error, /window has passed/);
        assert.strictEqual(JSON.parse(call(h, 'proposalInfo', ['1'], ATTACKER).result).status, 'EXPIRED');
        h.ledger.blockHeight = armedAt + TIMELOCK + WINDOW;
        assert.ok(call(h, 'executeProposal', ['1'], ATTACKER).success);
    });

    it('custody guard is exact: one base unit short refuses, exact balance pays', function () {
        const h = armed('guardian', '400');
        h.deposit(HOLDER, ADDR, PAY, '399.99999999');
        h.ledger.polls[POLL] = passedPoll();
        h.mineBlock(TIMELOCK);
        assert.match(call(h, 'executeProposal', ['1'], ATTACKER).error, /insufficient treasury balance/);
        h.deposit(HOLDER, ADDR, PAY, '0.00000001');
        assert.ok(call(h, 'executeProposal', ['1'], ATTACKER).success);
        assert.strictEqual(h.ledger.getBalance(ADDR, PAY), '0');
    });

    it('amount boundaries: 0 refused at propose, 1 base unit pays, sub-unit stays unpayable, off-grid floors', function () {
        const h0 = setup('guardian');
        assert.match(call(h0, 'propose', [PAYEE, PAY, '0', 'm'], HOLDER).error, /must be positive/);
        for (const bad of ['1e2', '0x10', '+1', '.5', '5.', '1_0', 'Infinity', '-1'])
            assert.ok(!call(h0, 'propose', [PAYEE, PAY, bad, 'm'], HOLDER).success, bad);

        const h1 = armed('guardian', '0.00000001');
        h1.deposit(HOLDER, ADDR, PAY, '1');
        h1.ledger.polls[POLL] = passedPoll();
        h1.mineBlock(TIMELOCK);
        const r1 = call(h1, 'executeProposal', ['1'], ATTACKER);
        assert.ok(r1.success, r1.error);
        assert.strictEqual(h1.ledger.getBalance(PAYEE, PAY), '0.00000001');

        const h2 = armed('guardian', '0.000000009');
        h2.deposit(HOLDER, ADDR, PAY, '1');
        h2.ledger.polls[POLL] = passedPoll();
        h2.mineBlock(TIMELOCK);
        assert.match(call(h2, 'executeProposal', ['1'], ATTACKER).error, /below one unit/);
        assert.strictEqual(rec(h2, '1').status, 'ARMED');

        const h3 = armed('guardian', '1.999999999');
        h3.deposit(HOLDER, ADDR, PAY, '2');
        h3.ledger.polls[POLL] = passedPoll();
        h3.mineBlock(TIMELOCK);
        assert.ok(call(h3, 'executeProposal', ['1'], ATTACKER).success);
        assert.strictEqual(rec(h3, '1').paid, '1.99999999');
        assert.strictEqual(h3.ledger.getBalance(PAYEE, PAY), '1.99999999');
    });

    it('decimals 0 tick and a huge amount behave on the grid', function () {
        const h = armed('guardian', '7.9', { payDecimals: 0, payBalance: '100' });
        h.deposit(HOLDER, ADDR, PAY, '100');
        h.ledger.polls[POLL] = passedPoll();
        h.mineBlock(TIMELOCK);
        assert.ok(call(h, 'executeProposal', ['1'], ATTACKER).success);
        assert.strictEqual(h.ledger.getBalance(PAYEE, PAY), '7');

        const huge = '1' + '0'.repeat(40);
        const hh = armed('guardian', huge, { payBalance: huge });
        hh.deposit(HOLDER, ADDR, PAY, huge);
        hh.ledger.polls[POLL] = passedPoll();
        hh.mineBlock(TIMELOCK);
        assert.ok(call(hh, 'executeProposal', ['1'], ATTACKER).success);
        assert.strictEqual(hh.ledger.getBalance(ADDR, PAY), '0');
        assert.strictEqual(hh.ledger.total(PAY), huge);
    });

    it('authorization: wrong callers are refused on every state-changing entry point', function () {
        const h = setup('guardian');
        assert.match(call(h, 'propose', [PAYEE, PAY, '1', 'm'], SMALL).error, /insufficient governance/);
        assert.match(call(h, 'propose', [PAYEE, PAY, '1', 'm'], ADDR).error, /contract cannot propose/);
        assert.ok(call(h, 'propose', [PAYEE, PAY, '1', 'm'], HOLDER2).success, 'exactly minProposeBalance proposes');
        for (const c of [HOLDER, ATTACKER, ADDR]) {
            assert.ok(!call(h, 'approvePoll', ['1', POLL], c).success, 'approvePoll by ' + c);
            assert.ok(!call(h, 'veto', ['1'], c).success, 'veto by ' + c);
        }
        for (const c of [GUARDIAN, HOLDER, ATTACKER]) assert.ok(!call(h, 'arm', armArgs('1'), c).success, 'arm by ' + c);
        for (const c of [GUARDIAN, HOLDER, ATTACKER, ADDR]) assert.ok(!call(h, 'cancel', ['1'], c).success, 'cancel by ' + c);
        assert.ok(call(h, 'cancel', ['1'], HOLDER2).success);
    });

    it('arming gates: unbound poll, wrong tick, wrong winner, tie and junk-electorate snapshot never pay', function () {
        const h = setup('guardian');
        call(h, 'propose', [PAYEE, PAY, '400', 'm'], HOLDER);
        assert.match(call(h, 'arm', armArgs('1'), ADDR).error, /guardian-approved/);
        call(h, 'approvePoll', ['1', POLL], GUARDIAN);
        assert.match(call(h, 'arm', armArgs('1', { tick: 'JUNK' }), ADDR).error, /electorate/);
        assert.match(call(h, 'arm', armArgs('1', { winning: '1' }), ADDR).error, /approval option/);
        assert.ok(!call(h, 'arm', armArgs('1').concat(['x']), ADDR).success, 'spare param');
        assert.ok(call(h, 'arm', armArgs('1'), ADDR).success);
        h.deposit(HOLDER, ADDR, PAY, '1000');
        h.mineBlock(TIMELOCK);
        h.ledger.polls[POLL] = passedPoll({ options: [{ index: 0, weight: '10' }, { index: 1, weight: '10' }] });
        assert.match(call(h, 'executeProposal', ['1'], ATTACKER).error, /strictly outweigh/);
        h.ledger.polls[POLL] = passedPoll({ tick: 'JUNK' });
        assert.match(call(h, 'executeProposal', ['1'], ATTACKER).error, /electorate/);
        delete h.ledger.polls[POLL];
        assert.match(call(h, 'executeProposal', ['1'], ATTACKER).error, /not verifiable/);
        h.ledger.polls[POLL] = passedPoll({ options: [{ index: 0, weight: '10.000000000000000001' }, { index: 1, weight: '10' }] });
        assert.ok(call(h, 'executeProposal', ['1'], ATTACKER).success, 'a dust-margin strict plurality pays');
    });

    it('two armed proposals cannot overdraw shared custody', function () {
        const h = setup('open');
        call(h, 'propose', [PAYEE, PAY, '300', 'a'], HOLDER);
        call(h, 'propose', [PAYEE, PAY, '300', 'b'], HOLDER);
        assert.ok(call(h, 'arm', armArgs('1'), ADDR).success);
        assert.ok(call(h, 'arm', armArgs('2'), ADDR).success);
        h.deposit(HOLDER, ADDR, PAY, '500');
        h.ledger.polls[POLL] = passedPoll();
        h.mineBlock(TIMELOCK);
        assert.ok(call(h, 'executeProposal', ['1'], ATTACKER).success);
        assert.match(call(h, 'executeProposal', ['2'], ATTACKER).error, /insufficient treasury balance/);
        assert.strictEqual(h.ledger.getBalance(ADDR, PAY), '200');
        assert.strictEqual(h.ledger.total(PAY), '5000');
    });

    it('non-canonical proposal ids and poll indexes are refused', function () {
        const h = setup('guardian');
        call(h, 'propose', [PAYEE, PAY, '1', 'm'], HOLDER);
        for (const id of ['01', '1.0', '1e0', '+1', '0', '2', '', null])
            assert.match(call(h, 'veto', [id], GUARDIAN).error, /unknown proposal/, String(id));
        for (const p of ['0501', '5.01e2', '+501', '0', ''])
            assert.ok(!call(h, 'approvePoll', ['1', p], GUARDIAN).success, p);
    });
});
