// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// escrow.test.js: behavioral + adversarial tests for escrow.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL escrow.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/escrow/escrow.test.js

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
} catch (e) { XChainVM = null; console.log('Skipping escrow tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'escrow.js'), 'utf8');

const BUYER   = 'buyer';
const SELLER  = 'seller';
const ARBITER = 'arbiter';
const STRANGER = 'stranger';
const ADDR    = 'C:BTC:1';
const TICK    = 'TEST';

(XChainVM ? describe : describe.skip)('Template: escrow', function () {
    this.timeout(0);
    let h;

    // Deploy a fresh escrow for TICK/200 with a 3-block reclaim window, the buyer
    // pre-funded with 200 TEST. Most tests then deposit + fund before settling.
    async function deployEscrow(window) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(BUYER, 'XCHAIN', '1000000');
        h.seedBalance(BUYER, TICK, '200');
        await h.deploy({
            code: CODE, deployer: BUYER, contractAddress: ADDR,
            params: [BUYER, SELLER, ARBITER, TICK, '200', String(window || 3)]
        });
    }

    // Atomic fund: deposit then fund(). Mirrors BATCH(DEPOSIT, EXECUTE("fund")).
    async function depositAndFund(amount) {
        h.deposit(BUYER, ADDR, TICK, amount || '200');
        return h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: BUYER });
    }

    describe('happy paths', function () {
        it('buyer releases funded escrow to the seller', async function () {
            await deployEscrow();
            assertSuccess(await depositAndFund());
            assertContractState(h.ledger, ADDR, 'status', 'FUNDED');

            const r = await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: BUYER });
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: SELLER, tick: TICK, quantity: '200' } }]);
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertBalance(h.ledger, SELLER, TICK, '200');
            assertContractState(h.ledger, ADDR, 'status', 'RELEASED');
        });

        it('seller refunds the buyer', async function () {
            await deployEscrow();
            await depositAndFund();
            const r = await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: SELLER });
            assertSuccess(r);
            assertBalance(h.ledger, BUYER, TICK, '200'); // returned in full
            assertContractState(h.ledger, ADDR, 'status', 'REFUNDED');
        });

        it('arbiter can release OR refund a dispute', async function () {
            await deployEscrow();
            await depositAndFund();
            const r = await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: ARBITER });
            assertSuccess(r);
            assertBalance(h.ledger, SELLER, TICK, '200');
        });

        it('buyer reclaims after the deadline via timeout()', async function () {
            await deployEscrow(3);
            await depositAndFund();
            // before the deadline: rejected
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: BUYER }),
                'deadline not reached');
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // height 1 -> 4 >= deadline(4)
            const r = await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: BUYER });
            assertSuccess(r);
            assertBalance(h.ledger, BUYER, TICK, '200');
            assertContractState(h.ledger, ADDR, 'status', 'REFUNDED');
        });

        // Regression: the reclaim deadline is anchored at fund(), not deploy.
        // When the deadline was set in initialize(), any deploy-to-funding delay
        // ate the seller's window, and funding at/after the deploy-anchored
        // deadline armed an escrow the buyer could timeout()-reclaim in the
        // same block, bypassing the seller/arbiter settlement path entirely.
        it('delayed funding still gives the seller the full reclaim window', async function () {
            await deployEscrow(3); // deployed at height 1
            // Negotiation drags on: 5 blocks pass before the buyer funds, well
            // past the old deploy-anchored deadline (1 + 3 = 4).
            for (let i = 0; i < 5; i++) h.mineBlock(); // height 6
            assertSuccess(await depositAndFund());

            // A just-funded escrow must NOT be instantly reclaimable.
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: BUYER }),
                'deadline not reached');

            // The seller/arbiter settlement path stays alive for the full window...
            h.mineBlock(); h.mineBlock(); // height 8 < deadline (6 + 3 = 9)
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: BUYER }),
                'deadline not reached');

            // ...and reclaim opens exactly at fund_height + window.
            h.mineBlock(); // height 9 >= deadline(9)
            const r = await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: BUYER });
            assertSuccess(r);
            assertBalance(h.ledger, BUYER, TICK, '200');
            assertContractState(h.ledger, ADDR, 'status', 'REFUNDED');
        });
    });

    describe('attacks we considered', function () {
        it('fund() rejects an underfunded deposit (no trust in caller-supplied amount)', async function () {
            await deployEscrow();
            assertReverted(await depositAndFund('100'), 'insufficient deposit');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
        });

        it('a stranger cannot release or refund', async function () {
            await deployEscrow();
            await depositAndFund();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: STRANGER }),
                'not authorized');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: STRANGER }),
                'not authorized');
            assertContractState(h.ledger, ADDR, 'status', 'FUNDED'); // untouched
        });

        it('the seller cannot release to themselves; the buyer cannot refund to themselves', async function () {
            await deployEscrow();
            await depositAndFund();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: SELLER }),
                'not authorized');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: BUYER }),
                'not authorized');
        });

        it('double-settle is impossible: second settlement reverts on the status guard', async function () {
            await deployEscrow();
            await depositAndFund();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: BUYER }));
            // any further settlement attempt (by anyone, any path) is blocked
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: BUYER }),
                'not funded');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: ARBITER }),
                'not funded');
            assertContractBalance(h.ledger, ADDR, TICK, '0'); // no second payout
        });

        it('settling before funding reverts', async function () {
            await deployEscrow();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: BUYER }),
                'not funded');
        });

        it('timeout() is buyer-only', async function () {
            await deployEscrow(3);
            await depositAndFund();
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: SELLER }),
                'not authorized');
        });

        it('fund() cannot re-arm a settled escrow', async function () {
            await deployEscrow();
            await depositAndFund();
            await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: BUYER });
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: BUYER }),
                'not awaiting funds');
        });
    });

    describe('deploy-time validation', function () {
        it('rejects a non-positive amount', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(BUYER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: BUYER, contractAddress: 'C:BTC:2',
                params: [BUYER, SELLER, ARBITER, TICK, '0', '3']
            });
            assert.strictEqual(r.success, false, 'deploy with amount=0 should revert in initialize');
        });
    });
});
