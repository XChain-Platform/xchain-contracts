// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// cardDispenser.test.js: behavioral + adversarial tests for cardDispenser.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL cardDispenser.js template (no copy), so the test can't drift.
//
// Run from the xchain-vm package so its deps resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/cardDispenser/cardDispenser.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
    assertBalance, assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions,
       assertBalance, assertContractBalance, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping cardDispenser tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'cardDispenser.js'), 'utf8');

const ADDR     = 'C:BTC:1';
const OWNER    = 'owner';
const BUYER    = 'buyer';
const STRANGER = 'stranger';
const PAY      = 'PAY';
const A = 'CARD_A', B = 'CARD_B', C = 'CARD_C';
const CARDS = [A, B, C];
const PRICE = '1';
const UNIT  = '1';

(XChainVM ? describe : describe.skip)('Template: cardDispenser', function () {
    this.timeout(0);
    let h;

    // Deploy a fresh dispenser for PAY/price 1, unit 1, cards A/B/C, then fund the
    // contract's custody with `stock` copies of each (default 5/5/5).
    async function deployDispenser(stock) {
        stock = stock || { [A]: 5, [B]: 5, [C]: 5 };
        h = new E2EHarness(XChainVM);
        h.seedBalance(OWNER, 'XCHAIN', '1000000');
        h.seedBalance(BUYER, 'XCHAIN', '1000000');
        h.seedBalance(BUYER, PAY, '1000');
        await h.deploy({
            code: CODE, deployer: OWNER, contractAddress: ADDR,
            params: [PAY, PRICE, UNIT, A, B, C]
        });
        for (const tick of CARDS)
            if (stock[tick]) h.ledger.creditContractBalance(ADDR, tick, String(stock[tick]));
    }

    // Pay-and-draw: mirrors BATCH(DEPOSIT(PAY, price), EXECUTE("draw")).
    async function draw() {
        h.deposit(BUYER, ADDR, PAY, PRICE);
        return h.execute({ contractAddress: ADDR, method: 'draw', params: [], caller: BUYER });
    }

    describe('happy paths', function () {
        it('a paid draw sends the buyer exactly one in-set card', async function () {
            await deployDispenser();
            const r = await draw();
            assertSuccess(r);
            // exactly one SEND, to the buyer, of one unit (tick is random)
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BUYER, quantity: UNIT } }]);
            const tick = r.emittedActions[0].params.tick;
            assert(CARDS.indexOf(tick) !== -1, 'drawn tick must be one of the declared cards, got ' + tick);
            assertBalance(h.ledger, BUYER, tick, '1');
            assertContractBalance(h.ledger, ADDR, tick, '4');   // 5 -> 4
            assertContractState(h.ledger, ADDR, 'nonce', '1');
        });

        it('the draw counter advances each successful draw', async function () {
            await deployDispenser();
            await draw();
            await draw();
            assertContractState(h.ledger, ADDR, 'nonce', '2');
        });

        it('owner can withdraw the accumulated proceeds (payTick)', async function () {
            await deployDispenser();
            await draw();
            await draw();   // 2 PAY now held by the contract
            const r = await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [PAY], caller: OWNER });
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: OWNER, tick: PAY, quantity: '2' } }]);
            assertContractBalance(h.ledger, ADDR, PAY, '0');
        });

        // Regression: the sweep moves payTick OUT of custody, so the acctPay
        // watermark draw() measures against has to follow it down. Leaving the
        // watermark at the pre-sweep total makes every later draw() compute a
        // negative delta and revert 'underpaid' forever.
        it('a draw still works after the owner sweeps the proceeds', async function () {
            await deployDispenser();
            await draw();
            await draw();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [PAY], caller: OWNER }));
            assertContractBalance(h.ledger, ADDR, PAY, '0');
            assertContractState(h.ledger, ADDR, 'acctPay', '0');
            assertSuccess(await draw());
            assertContractState(h.ledger, ADDR, 'nonce', '3');
        });

        it('info() reports remaining stock', async function () {
            await deployDispenser();
            const r = await h.execute({ contractAddress: ADDR, method: 'info', params: [], caller: STRANGER });
            assertSuccess(r);
            assert(r.returnValue && r.returnValue.indexOf('stock') !== -1, 'info should report stock');
        });
    });

    describe('distribution & coverage', function () {
        // Draining the whole pool proves every in-stock card is reachable: 15
        // draws against 5+5+5 copies must dispense each card exactly its stock
        // count (you can never send a card you do not hold) and leave the
        // contract empty — i.e. the selection covers ALL held tokens.
        it('drains the entire pool, covering every card', async function () {
            await deployDispenser({ [A]: 5, [B]: 5, [C]: 5 });
            const counts = { [A]: 0, [B]: 0, [C]: 0 };
            for (let i = 0; i < 15; i++) {
                const r = await draw();
                assertSuccess(r);
                counts[r.emittedActions[0].params.tick]++;
            }
            assert.strictEqual(counts[A], 5, 'CARD_A fully dispensed');
            assert.strictEqual(counts[B], 5, 'CARD_B fully dispensed');
            assert.strictEqual(counts[C], 5, 'CARD_C fully dispensed');
            for (const tick of CARDS) assertContractBalance(h.ledger, ADDR, tick, '0');
        });

        it('does not always return the same card (randomness varies the outcome)', async function () {
            await deployDispenser({ [A]: 50, [B]: 50, [C]: 50 });
            const seen = {};
            for (let i = 0; i < 12; i++) {
                const r = await draw();
                assertSuccess(r);
                seen[r.emittedActions[0].params.tick] = true;
            }
            assert(Object.keys(seen).length >= 2, 'expected more than one distinct card across 12 draws');
        });
    });

    describe('attacks we considered', function () {
        it('an underpaid draw reverts (no trust in caller-supplied amount)', async function () {
            await deployDispenser();
            // EXECUTE("draw") with NO preceding DEPOSIT: paid delta is 0 < price.
            const r = await h.execute({ contractAddress: ADDR, method: 'draw', params: [], caller: BUYER });
            assertReverted(r, 'underpaid');
            assertContractState(h.ledger, ADDR, 'nonce', '0'); // untouched
        });

        it('when sold out the payment is refunded, not stranded', async function () {
            await deployDispenser({ [A]: 1 });   // one card total (B, C empty)
            const first = await draw();
            assertSuccess(first);
            assert.strictEqual(first.emittedActions[0].params.tick, A);

            const r = await draw();   // nothing left -> refund
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BUYER, tick: PAY, quantity: PRICE } }]);
            assertBalance(h.ledger, BUYER, A, '1');     // kept the one card it drew
            assertBalance(h.ledger, BUYER, PAY, '999'); // 1000 - 2 deposits + 1 refund
        });

        // Regression: the refund leaves custody too, so the watermark must land
        // on the POST-refund balance. Advancing it to the pre-refund balance
        // over-counts by exactly the refund and bricks the restocked dispenser.
        it('a draw still works after a sold-out refund and a restock', async function () {
            await deployDispenser({ [A]: 1 });
            const first = await draw();
            assertSuccess(first);
            assert.strictEqual(first.emittedActions[0].params.tick, A);

            assertSuccess(await draw());                       // sold out -> refund
            assertContractBalance(h.ledger, ADDR, PAY, '1');
            assertContractState(h.ledger, ADDR, 'acctPay', '1');

            h.ledger.creditContractBalance(ADDR, B, '1');      // operator restocks
            const third = await draw();
            assertSuccess(third);
            assert.strictEqual(third.emittedActions[0].params.tick, B);
        });

        it('only the owner can withdraw', async function () {
            await deployDispenser();
            await draw();
            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [PAY], caller: STRANGER }),
                'owner only'
            );
        });
    });

    describe('deploy-time validation', function () {
        it('rejects a deploy with no card ticks', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(OWNER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: OWNER, contractAddress: 'C:BTC:2',
                params: [PAY, PRICE, UNIT]   // no cards
            });
            assert.strictEqual(r.success, false, 'deploy without cards should revert in initialize');
        });

        it('rejects a non-positive price', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(OWNER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: OWNER, contractAddress: 'C:BTC:3',
                params: [PAY, '0', UNIT, A]
            });
            assert.strictEqual(r.success, false, 'deploy with price=0 should revert in initialize');
        });
    });
});
