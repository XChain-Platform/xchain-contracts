// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// escrow_test/invariants.js: seeded invariant tests for escrow.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng } = require('../../test/helpers/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'escrow.js'), 'utf8');
const ADDR = 'C:BTC:1';
const TICK = 'TEST';
const ACTORS = ['buyer', 'seller', 'arbiter', 'stranger'];
const METHODS = ['fund', 'release', 'refund', 'timeout', 'cancel'];

function setup(amount, window) {
    const h = new Harness();
    h.seedBalance('buyer', TICK, '1000');
    const r = h.deploy({ code: CODE, deployer: 'buyer', contractAddress: ADDR,
        params: ['buyer', 'seller', 'arbiter', TICK, amount || '200', String(window || 3)] });
    assert.ok(r.success, r.error);
    return h;
}

(available ? describe : describe.skip)('escrow invariants (in-process)', function () {
    it('conservation and single settlement across seeded random call sequences', function () {
        for (let seed = 1; seed <= 200; seed++) {
            const R = rng(seed);
            const h = setup();
            let payouts = 0;
            for (let step = 0; step < 25; step++) {
                if (R.next() < 0.25) h.deposit('buyer', ADDR, TICK, String(R.int(1, 150)));
                if (R.next() < 0.2) h.mineBlock(R.int(1, 3));
                const r = h.execute({ contractAddress: ADDR, method: R.pick(METHODS), params: [], caller: R.pick(ACTORS) });
                if (r.success) payouts += r.actions.filter((a) => a.action === 'SEND').length;
                assert.strictEqual(h.ledger.total(TICK), '1000', 'seed ' + seed + ' supply drift');
            }
            assert.ok(payouts <= 1, 'seed ' + seed + ': more than one payout (' + payouts + ')');
        }
    });

    it('release and refund cannot both settle the same deposit', function () {
        const h = setup();
        h.deposit('buyer', ADDR, TICK, '200');
        assert.ok(h.execute({ contractAddress: ADDR, method: 'fund', caller: 'buyer' }).success);
        assert.ok(h.execute({ contractAddress: ADDR, method: 'release', caller: 'arbiter' }).success);
        h.deposit('buyer', ADDR, TICK, '5');
        for (const m of ['refund', 'release', 'timeout', 'cancel', 'fund'])
            for (const c of ACTORS)
                assert.ok(!h.execute({ contractAddress: ADDR, method: m, caller: c }).success, m + ' by ' + c);
    });

    it('authorization: only the documented roles settle', function () {
        const allowed = { release: ['buyer', 'arbiter'], refund: ['seller', 'arbiter'] };
        for (const m of Object.keys(allowed)) for (const c of ACTORS) {
            const h = setup();
            h.deposit('buyer', ADDR, TICK, '200');
            h.execute({ contractAddress: ADDR, method: 'fund', caller: 'buyer' });
            assert.strictEqual(h.execute({ contractAddress: ADDR, method: m, caller: c }).success,
                allowed[m].indexOf(c) >= 0, m + ' by ' + c);
        }
    });

    it('timeout honours the window boundary exactly', function () {
        const h = setup('200', 3);
        h.deposit('buyer', ADDR, TICK, '200');
        h.execute({ contractAddress: ADDR, method: 'fund', caller: 'buyer' });
        h.mineBlock(2);
        assert.ok(!h.execute({ contractAddress: ADDR, method: 'timeout', caller: 'buyer' }).success);
        h.mineBlock(1);
        assert.ok(h.execute({ contractAddress: ADDR, method: 'timeout', caller: 'buyer' }).success);
    });

    it('fund requires the exact amount: one base unit short is refused', function () {
        const h = setup('200', 3);
        h.deposit('buyer', ADDR, TICK, '199.99999999');
        assert.ok(!h.execute({ contractAddress: ADDR, method: 'fund', caller: 'buyer' }).success);
        h.deposit('buyer', ADDR, TICK, '0.00000001');
        assert.ok(h.execute({ contractAddress: ADDR, method: 'fund', caller: 'buyer' }).success);
    });

    it('constructor boundaries: zero amount and out-of-range windows revert', function () {
        for (const p of [['0', '3'], ['200', '0'], ['200', '1000001'], ['1e2', '3'], ['200', '1e3']]) {
            const h = new Harness();
            const r = h.deploy({ code: CODE, deployer: 'buyer', contractAddress: ADDR,
                params: ['buyer', 'seller', 'arbiter', TICK, p[0], p[1]] });
            assert.ok(!r.success, p.join(','));
        }
    });
});
