// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// safe_transfer_order.test.js: englishAuction and cardDispenser commit state before any emit
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// patterns/safe-transfer.js teaches one rule: commit state first, emit after.
// Emissions are deferred, so a wrong order is not exploitable today, but a
// template is copied into contracts and the order is the lesson. The harness
// here records every state.set and emit.* call in call order, so a method that
// emits and then writes state fails by name instead of passing on its result.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/safe_transfer_order.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const { available, Harness } = require('./helpers/harness.js');

const ROOT = path.join(__dirname, '..');
const code = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

class TraceHarness extends Harness {
    constructor() { super(); this.trace = []; }
    makeApi(addr, params, caller, actions) {
        const api = super.makeApi(addr, params, caller, actions);
        const trace = this.trace;
        const set = api.state.set;
        api.state.set = (k, v) => { trace.push('set:' + k); return set(k, v); };
        for (const name of Object.keys(api.emit)) {
            const emit = api.emit[name];
            api.emit[name] = (p) => { trace.push('emit:' + name); return emit(p); };
        }
        return api;
    }
}

// Every state write of the last call precedes its first emission.
function assertStateBeforeEmit(trace, label) {
    const firstEmit = trace.findIndex((t) => t.startsWith('emit:'));
    assert.ok(firstEmit >= 0, label + ': the call emitted nothing, so the order was not exercised');
    const lateWrite = trace.slice(firstEmit).filter((t) => t.startsWith('set:'));
    assert.deepStrictEqual(lateWrite, [], label + ': state written after an emission');
}

function run(h, addr, method, caller, params) {
    h.trace.length = 0;
    const r = h.execute({ contractAddress: addr, method: method, params: params || [], caller: caller });
    assert.ok(r.success, method + ' failed: ' + r.error);
    return r;
}

const suite = available ? describe : describe.skip;

suite('safe-transfer ordering in englishAuction.bid', function () {
    this.timeout(0);

    const ADDR = 'C:BTC:21';
    function auction() {
        const h = new TraceHarness();
        h.ledger.setTokenDecimals('ITEM', 0);
        h.ledger.setTokenDecimals('BID', 0);
        h.seedBalance('seller', 'ITEM', '10');
        for (const b of ['b1', 'b2']) h.seedBalance(b, 'BID', '1000');
        assert.ok(h.deploy({ code: code('englishAuction/englishAuction.js'), deployer: 'seller',
            contractAddress: ADDR, params: ['seller', 'ITEM', '10', 'BID', '50', '50'] }).success);
        h.deposit('seller', ADDR, 'ITEM', '10');
        run(h, ADDR, 'fund', 'seller');
        return h;
    }
    function bid(h, who, amount) {
        h.deposit(who, ADDR, 'BID', amount);
        return run(h, ADDR, 'bid', who);
    }

    it('writes the new leader before refunding the displaced one, and refunds the old amount', function () {
        const h = auction();
        bid(h, 'b1', '60');
        const r = bid(h, 'b2', '90');
        assertStateBeforeEmit(h.trace, 'bid');
        assert.deepStrictEqual(r.actions.map((a) => [a.action, a.params.destination, a.params.quantity]),
            [['SEND', 'b1', '60']]);
        assert.strictEqual(h.state(ADDR, 'highBid'), '90');
        assert.strictEqual(h.state(ADDR, 'highBidder'), 'b2');
    });

    it('settle and cancel keep their existing state-first order', function () {
        const h = auction();
        run(h, ADDR, 'cancel', 'seller');
        assertStateBeforeEmit(h.trace, 'cancel');
        const g = auction();
        bid(g, 'b1', '60');
        g.mineBlock(60);
        run(g, ADDR, 'settle', 'b2');
        assertStateBeforeEmit(g.trace, 'settle');
    });
});

suite('safe-transfer ordering in cardDispenser', function () {
    this.timeout(0);

    const ADDR = 'C:BTC:22';
    function dispenser(stock) {
        const h = new TraceHarness();
        h.seedBalance('buyer', 'PAY', '1000');
        h.seedBalance('owner', 'CA', '100');
        h.ledger.setTokenDecimals('CA', 0);
        h.ledger.setTokenDecimals('PAY', 0);
        assert.ok(h.deploy({ code: code('cardDispenser/cardDispenser.js'), deployer: 'owner',
            contractAddress: ADDR, params: ['PAY', '5', '1', 'CA'] }).success);
        if (stock) h.deposit('owner', ADDR, 'CA', stock);
        return h;
    }

    it('draw commits the payment watermark and nonce before it dispenses', function () {
        const h = dispenser('3');
        h.deposit('buyer', ADDR, 'PAY', '5');
        const r = run(h, ADDR, 'draw', 'buyer');
        assertStateBeforeEmit(h.trace, 'draw dispense');
        assert.strictEqual(r.result, 'CA');
        assert.strictEqual(h.state(ADDR, 'acctPay'), '5');
        assert.strictEqual(h.state(ADDR, 'nonce'), '1');
    });

    it('the sold-out refund commits the watermark before it refunds', function () {
        const h = dispenser(null);
        h.deposit('buyer', ADDR, 'PAY', '5');
        const r = run(h, ADDR, 'draw', 'buyer');
        assertStateBeforeEmit(h.trace, 'draw sold out');
        assert.strictEqual(r.result, 'sold_out');
        assert.strictEqual(h.state(ADDR, 'acctPay'), '0');
        assert.deepStrictEqual(r.actions.map((a) => [a.action, a.params.quantity]), [['SEND', '5']]);
    });

    it('a payTick sweep resets the watermark before it sends', function () {
        const h = dispenser('3');
        h.deposit('buyer', ADDR, 'PAY', '5');
        run(h, ADDR, 'draw', 'buyer');
        run(h, ADDR, 'withdraw', 'owner', ['PAY']);
        assertStateBeforeEmit(h.trace, 'withdraw');
        assert.strictEqual(h.state(ADDR, 'acctPay'), '0');
    });
});

suite('safe-transfer ordering falsification', function () {
    it('the trace check fails on an emit-then-write method', function () {
        assert.throws(() => assertStateBeforeEmit(['emit:send', 'set:highBid'], 'stale'),
            /state written after an emission/);
    });

    it('the trace check fails on a call that emitted nothing', function () {
        assert.throws(() => assertStateBeforeEmit(['set:status'], 'idle'), /emitted nothing/);
    });
});
