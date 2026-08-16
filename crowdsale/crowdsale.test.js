// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// crowdsale.test.js: behavioral + adversarial tests for crowdsale.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Loads the ACTUAL crowdsale.js and runs it through xchain-vm's E2E harness
// (isolated-vm / Node 22). Run from the xchain-vm package:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/crowdsale/crowdsale.test.js
//
// Note on assertions: the E2E MockIndexer applies SEND (custody -> recipient) but
// its MINT handler credits the contract and ignores `destination`, and ISSUE is a
// no-op. So token DELIVERY (mint to buyer) is checked via the emitted MINT action
// (the contract's logic), while payTick movements (refund/withdraw via SEND) are
// checked against resulting balances.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertBalance;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertBalance }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping crowdsale tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'crowdsale.js'), 'utf8');

const OWNER = 'owner', B1 = 'buyer1', B2 = 'buyer2', STRANGER = 'stranger';
const ADDR = 'C:BTC:1', PAY = 'PAY', SALE = 'SALE';
const RATE = '10', SOFT = '100', HARD = '200', DURATION = 50;
const DEADLINE = 1 + DURATION; // deploy at height 1

(XChainVM ? describe : describe.skip)('Template: crowdsale', function () {
    this.timeout(0);
    let h;

    async function deploy(over) {
        over = over || {};
        h = new E2EHarness(XChainVM);
        for (const a of [OWNER, B1, B2]) { h.seedBalance(a, 'XCHAIN', '1000000'); h.seedBalance(a, PAY, '500'); }
        return h.deploy({
            code: CODE, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, PAY, SALE, over.rate || RATE, over.soft || SOFT, over.hard || HARD,
                     String(DURATION), '8']
        });
    }
    // Atomic pay: DEPOSIT then buy(), mirroring BATCH(DEPOSIT, EXECUTE("buy")).
    async function buy(who, amount) {
        h.deposit(who, ADDR, PAY, amount);
        return h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: who });
    }
    function call(method, who) { return h.execute({ contractAddress: ADDR, method, params: [], caller: who }); }
    function close() { h.ledger.blockHeight = DEADLINE; }

    describe('successful sale', function () {
        it('buyers fund past the soft cap, finalize, claim tokens, owner withdraws', async function () {
            assertSuccess(await deploy());
            assertSuccess(await buy(B1, '60'));
            assertSuccess(await buy(B2, '60')); // raised 120 >= soft 100
            close();
            assertSuccess(await call('finalize', B1));

            // Buyer claims sale tokens: 60 * 10 = 600 minted to B1.
            const c = await call('claim', B1);
            assertSuccess(c);
            assertEmittedActions(c, [{ action: 'MINT', params: { tick: SALE, quantity: '600', destination: B1 } }]);
            assertReverted(await call('claim', B1), 'nothing to claim'); // no double claim

            // Owner withdraws the proceeds (120 PAY).
            const w = await call('withdraw', OWNER);
            assertSuccess(w);
            assertEmittedActions(w, [{ action: 'SEND', params: { destination: OWNER, tick: PAY, quantity: '120' } }]);
            assertBalance(h.ledger, OWNER, PAY, '620'); // started 500 + 120 proceeds
            assertReverted(await call('withdraw', OWNER), 'already withdrawn');
        });
    });

    describe('failed sale', function () {
        it('under the soft cap, buyers refund in full; no claim, no withdraw', async function () {
            await deploy();
            await buy(B1, '50'); // raised 50 < soft 100
            close();
            assertSuccess(await call('finalize', B1)); // FAILED

            assertReverted(await call('claim', B1), 'sale not successful');
            assertReverted(await call('withdraw', OWNER), 'sale not successful');

            const r = await call('refund', B1);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: B1, tick: PAY, quantity: '50' } }]);
            assertBalance(h.ledger, B1, PAY, '500'); // 500 - 50 deposit + 50 refund
            assertReverted(await call('refund', B1), 'nothing to refund'); // no double refund
        });
    });

    describe('attacks we considered', function () {
        it('buy() with no deposit reverts', async function () {
            await deploy();
            assertReverted(await call('buy', B1), 'no payment received');
        });

        it('buying past the deadline reverts', async function () {
            await deploy();
            close();
            assertReverted(await buy(B1, '50'), 'sale closed');
        });

        it('a contribution beyond the hard cap is rejected', async function () {
            await deploy();
            assertSuccess(await buy(B1, '200')); // exactly the hard cap
            assertReverted(await buy(B2, '1'), 'hard cap exceeded');
        });

        it('finalize before the deadline (below cap) reverts', async function () {
            await deploy();
            await buy(B1, '60');
            assertReverted(await call('finalize', B1), 'sale still open');
        });

        it('claim before finalize reverts', async function () {
            await deploy();
            await buy(B1, '120');
            assertReverted(await call('claim', B1), 'sale not successful');
        });

        it('only the owner can withdraw', async function () {
            await deploy();
            await buy(B1, '120');
            close();
            await call('finalize', B1);
            assertReverted(await call('withdraw', STRANGER), 'only the owner');
        });

        it('hard cap reached allows early finalize before the deadline', async function () {
            await deploy();
            await buy(B1, '200'); // hits hard cap
            assertSuccess(await call('finalize', B1)); // early finalize OK (at cap)
        });
    });

    describe('precision (indexer half-up round-up over-issuance)', function () {
        it('floors the claim mint onto the saleTick decimal grid instead of over-issuing', async function () {
            // saleTick has 0 decimals; a contribution whose paid*rate lands on .5 would
            // half-up round UP at ledger-write (101.5 -> 102), minting more than paid*rate
            // and eventually past maxMint. The contract must EMIT the floored '101'.
            h = new E2EHarness(XChainVM);
            for (const a of [OWNER, B1]) { h.seedBalance(a, 'XCHAIN', '1000000'); h.seedBalance(a, PAY, '500'); }
            assertSuccess(await h.deploy({
                code: CODE, deployer: OWNER, contractAddress: ADDR,
                params: [OWNER, PAY, SALE, '10', '1', '200', String(DURATION), '0'] // rate 10, soft 1, hard 200, saleDecimals 0
            }));
            assertSuccess(await buy(B1, '10.15')); // paid 10.15 -> tokens 101.5
            close();
            assertSuccess(await call('finalize', B1));

            const c = await call('claim', B1);
            assertSuccess(c);
            // Floored DOWN to the 0dp grid -> '101', never the half-up round-up '102'
            // (and never the unfloored '101.5' the indexer would re-normalise upward).
            assertEmittedActions(c, [{ action: 'MINT', params: { tick: SALE, quantity: '101', destination: B1 } }]);
        });
    });

    describe('deploy-time validation', function () {
        async function bad(params) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(OWNER, 'XCHAIN', '1000000');
            return b.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9', params });
        }
        it('rejects payTick == saleTick', async function () {
            assert.strictEqual((await bad([OWNER, PAY, PAY, RATE, SOFT, HARD, '50', '8'])).success, false);
        });
        it('rejects hardCap < softCap', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, '200', '100', '50', '8'])).success, false);
        });
        it('rejects rate <= 0', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, '0', SOFT, HARD, '50', '8'])).success, false);
        });
        // saleDecimals validation (finding 2705): it feeds both the permanent
        // emit.issue grid and claim()'s floor; a malformed value must fail the
        // deploy instead of desyncing the two.
        it('rejects a non-numeric saleDecimals', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', 'eight'])).success, false);
        });
        it('rejects a fractional saleDecimals', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '8.5'])).success, false);
        });
        it('rejects a negative saleDecimals', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '-1'])).success, false);
        });
        it('rejects saleDecimals above the ISSUE maximum of 18', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '19'])).success, false);
        });
        it('accepts the boundary values 0 and 18', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '0'])).success, true);
            const b2 = new E2EHarness(XChainVM);
            b2.seedBalance(OWNER, 'XCHAIN', '1000000');
            const r = await b2.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
                params: [OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '18'] });
            assert.strictEqual(r.success, true);
        });
        it('an omitted saleDecimals still defaults to 8', async function () {
            const b3 = new E2EHarness(XChainVM);
            b3.seedBalance(OWNER, 'XCHAIN', '1000000');
            const r = await b3.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
                params: [OWNER, PAY, SALE, RATE, SOFT, HARD, '50'] });
            assert.strictEqual(r.success, true);
            const issue = r.result.emittedActions.find(e => e.action === 'ISSUE');
            assert.strictEqual(issue.params.decimals, '8');
        });
    });
});
