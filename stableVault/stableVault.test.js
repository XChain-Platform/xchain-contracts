// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// stableVault.test.js: behavioral + adversarial tests for stableVault.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL stableVault.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/stableVault/stableVault.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertBalance,
    assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertBalance, assertContractBalance,
       assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping stableVault tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'stableVault.js'), 'utf8');

const ALICE  = 'alice';
const BOB    = 'bob';
const LIQ    = 'liquidator';
const ADDR   = 'C:BTC:1';
const COLL   = 'GOLD';      // collateral token
const STABLE = 'DUSD';      // the stable this contract mints
const PAIR   = 'GOLD/USD';
const RATIO  = '150';       // 150% minimum collateralization
const BONUS  = '10';        // 10% liquidation bonus
const MAXAGE = '10';        // oracle freshness window, blocks

(XChainVM ? describe : describe.skip)('Template: stableVault (mini-MakerDAO)', function () {
    this.timeout(0);
    let h;

    async function deployVault() {
        h = new E2EHarness(XChainVM);
        h.seedBalance(ALICE, 'XCHAIN', '1000000');
        h.seedBalance(ALICE, COLL, '100');
        h.seedBalance(BOB, COLL, '100');
        // Register decimals so the ledger normalizes emissions the way the real
        // indexer does and getTokenInfo (used by liquidate's grid-flooring) works.
        h.ledger.setTokenDecimals(COLL, 8);
        h.ledger.setTokenDecimals(STABLE, 8);
        await h.deploy({
            code: CODE, deployer: ALICE, contractAddress: ADDR,
            params: [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE]
        });
    }

    // Latest finalized round in the production accessor shape.
    function setPrice(price, age) {
        h.ledger.seedOracle(PAIR,
            { price: String(price), roundNumber: 1, timestamp: 1700000000 },
            age || 0, {});
    }

    async function depositColl(who, amount) {
        h.deposit(who, ADDR, COLL, amount);
        return h.execute({ contractAddress: ADDR, method: 'deposit', params: [], caller: who });
    }
    async function borrow(who, amount) {
        return h.execute({ contractAddress: ADDR, method: 'borrow', params: [amount], caller: who });
    }
    async function repay(who, amount) {
        h.deposit(who, ADDR, STABLE, amount);
        return h.execute({ contractAddress: ADDR, method: 'repay', params: [], caller: who });
    }
    async function withdraw(who, amount) {
        return h.execute({ contractAddress: ADDR, method: 'withdraw', params: [amount], caller: who });
    }
    async function liquidate(who, owner, stakedStable) {
        h.deposit(who, ADDR, STABLE, stakedStable);
        return h.execute({ contractAddress: ADDR, method: 'liquidate', params: [owner], caller: who });
    }

    describe('happy paths', function () {
        it('deposit collateral, borrow up to the ratio limit, not a unit more', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':coll', '3');

            // 3 GOLD * $100 * 100 = 30000 >= debt * 150  ->  max debt 200.
            assertSuccess(await borrow(ALICE, '200'));
            assertBalance(h.ledger, ALICE, STABLE, '200');
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':debt', '200');
            assertContractState(h.ledger, ADDR, 'totalDebt', '200');
            // Mint + send net out: no stable strands in custody.
            assertContractBalance(h.ledger, ADDR, STABLE, '0');

            assertReverted(await borrow(ALICE, '1'), 'under-collateralized');
        });

        it('repay burns the debt and refunds any excess stable', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            h.seedBalance(ALICE, STABLE, '250'); // 200 borrowed + 50 spare

            assertSuccess(await repay(ALICE, '250'));
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
            assertContractState(h.ledger, ADDR, 'totalDebt', '0');
            assertBalance(h.ledger, ALICE, STABLE, '50');      // excess back
            assertContractBalance(h.ledger, ADDR, STABLE, '0'); // 200 burned
        });

        it('a debt-free vault withdraws everything without touching the oracle', async function () {
            await deployVault();
            // No setPrice on purpose: withdraw with zero debt must not read it.
            await depositColl(ALICE, '3');
            assertSuccess(await withdraw(ALICE, '3'));
            assertBalance(h.ledger, ALICE, COLL, '100');
            assertContractState(h.ledger, ADDR, 'trackedColl', '0');
        });

        it('withdraw is allowed down to exactly the minimum ratio, blocked below it', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '5');
            await borrow(ALICE, '200');
            // 3 GOLD left * $100 * 100 = 30000 == 200 * 150: exactly at the line.
            assertSuccess(await withdraw(ALICE, '2'));
            assertReverted(await withdraw(ALICE, '1'), 'under-collateralized');
        });

        it('vaults are attributed per caller: two depositors never mix', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await depositColl(BOB, '5');
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':coll', '3');
            assertContractState(h.ledger, ADDR, 'v:' + BOB + ':coll', '5');
            assertContractState(h.ledger, ADDR, 'trackedColl', '8');

            // Bob's collateral cannot back Alice's loan.
            assertReverted(await borrow(ALICE, '300'), 'under-collateralized');
            assertSuccess(await borrow(BOB, '300'));
        });

        it('price drop: anyone liquidates, seizes debt + bonus, owner keeps the rest', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');

            setPrice('80'); // 3 * 80 * 100 = 24000 < 200 * 150 = 30000 -> under water
            h.seedBalance(LIQ, STABLE, '200');

            assertSuccess(await liquidate(LIQ, ALICE, '200'));
            // Seized: 200 * 110 / (80 * 100) = 2.75 GOLD.
            assertBalance(h.ledger, LIQ, COLL, '2.75');
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':coll', '0.25');
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
            assertContractState(h.ledger, ADDR, 'totalDebt', '0');
            assertContractBalance(h.ledger, ADDR, STABLE, '0'); // debt burned

            // The leftover 0.25 GOLD still belongs to Alice.
            assertSuccess(await withdraw(ALICE, '0.25'));
        });

        it('non-grid seizure is floored to the collateral decimals: custody == books', async function () {
            // 0-decimal collateral with a price that puts the raw seizure
            // (2.75) off the decimal grid. Before the floorToDecimals fix the
            // books recorded 2.75 while the indexer rounded the wire amount
            // HALF-UP to 3, debiting custody 0.25 more than books and
            // leaving a pooled shortfall other vaults would eat.
            const COLL0 = 'IRON';
            h = new E2EHarness(XChainVM);
            h.seedBalance(ALICE, 'XCHAIN', '1000000');
            h.seedBalance(ALICE, COLL0, '100');
            h.ledger.setTokenDecimals(COLL0, 0);
            h.ledger.setTokenDecimals(STABLE, 8);
            await h.deploy({
                code: CODE, deployer: ALICE, contractAddress: ADDR,
                params: [COLL0, STABLE, PAIR, RATIO, BONUS, MAXAGE]
            });
            setPrice('100');
            h.deposit(ALICE, ADDR, COLL0, '3');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'deposit', params: [], caller: ALICE }));
            assertSuccess(await borrow(ALICE, '200'));

            setPrice('80'); // raw seize = 200 * 110 / 8000 = 2.75, off the 0dp grid
            h.seedBalance(LIQ, STABLE, '200');
            assertSuccess(await liquidate(LIQ, ALICE, '200'));

            // Floored to 2 whole IRON; books and custody agree exactly.
            assertBalance(h.ledger, LIQ, COLL0, '2');
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':coll', '1');
            assertContractState(h.ledger, ADDR, 'trackedColl', '1');
            assert.strictEqual(h.ledger.getContractBalance(ADDR, COLL0) || '0', '1',
                'contract custody must equal trackedColl after a non-grid liquidation');

            // The invariant holds end-to-end: the owner can withdraw the full
            // remaining balance (this reverted under the pre-fix drift).
            assertSuccess(await withdraw(ALICE, '1'));
            assert.strictEqual(h.ledger.getContractBalance(ADDR, COLL0) || '0', '0');
            assertContractState(h.ledger, ADDR, 'trackedColl', '0');
        });

        it('info() reports the system terms and totals', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '100');
            const r = await h.execute({ contractAddress: ADDR, method: 'info', params: [], caller: BOB });
            assertSuccess(r);
            const info = JSON.parse(JSON.parse(r.returnValue));
            assert.strictEqual(info.stableTick, STABLE);
            assert.strictEqual(info.totalDebt, '100');
            assert.strictEqual(info.trackedColl, '3');
        });
    });

    describe('attacks we considered', function () {
        it('liquidating a healthy vault reverts', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            h.seedBalance(LIQ, STABLE, '200');
            assertReverted(await liquidate(LIQ, ALICE, '200'), 'vault is healthy');
        });

        it('a liquidation that does not cover the full debt reverts', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            setPrice('80');
            h.seedBalance(LIQ, STABLE, '150');
            assertReverted(await liquidate(LIQ, ALICE, '150'), 'must cover the full debt');
        });

        it('you cannot liquidate your own vault, nor a vault with no debt', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '200');
            setPrice('80');
            h.seedBalance(ALICE, STABLE, '200');
            assertReverted(await liquidate(ALICE, ALICE, '200'), 'cannot liquidate your own vault');
            h.seedBalance(LIQ, STABLE, '200');
            assertReverted(await liquidate(LIQ, BOB, '200'), 'vault has no debt');
        });

        it('a stale oracle blocks borrow/withdraw/liquidate but never deposit/repay', async function () {
            await deployVault();
            setPrice('100');
            await depositColl(ALICE, '3');
            await borrow(ALICE, '100');

            setPrice('100', 50); // snapshot 50 blocks old > maxSnapshotAge 10
            assertReverted(await borrow(ALICE, '10'), 'oracle price is stale');
            assertReverted(await withdraw(ALICE, '1'), 'oracle price is stale');
            h.seedBalance(LIQ, STABLE, '100');
            assertReverted(await liquidate(LIQ, ALICE, '100'), 'oracle price is stale');

            // De-risking must always work: deposit more, repay in full.
            assertSuccess(await depositColl(ALICE, '1'));
            assertSuccess(await repay(ALICE, '100'));
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
        });

        it('borrow with an empty vault reverts', async function () {
            await deployVault();
            setPrice('100');
            assertReverted(await borrow(BOB, '1'), 'under-collateralized');
        });

        it('deposit without actually sending collateral reverts', async function () {
            await deployVault();
            const r = await h.execute({ contractAddress: ADDR, method: 'deposit', params: [], caller: ALICE });
            assertReverted(r, 'no collateral received');
        });
    });

    // Notation gate on the per-call amounts. Unlike liquidate()'s seizure, which
    // xchain.math computes (and the VM always formats in fixed notation),
    // borrow()/withdraw() take `amount` as raw caller text, and
    // math.gt(amount, '0') accepts every spelling mathjs parses. floorToDecimals
    // is string surgery that assumes fixed notation, so fed '1.5e-8' it NO-OPS
    // (the fraction '5e-8' is 4 chars, under the 8-decimal grid, so the
    // already-on-grid early return fires): the raw off-grid value reaches the
    // vault books while the indexer re-rounds the wire amount HALF-UP to
    // 0.00000002. Half a base unit of pooled custody-vs-books shortfall, on
    // EVERY call rather than once at deploy.
    describe('non-fixed-notation amounts are rejected at the call seam', function () {
        const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                     '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                     'Infinity', 'NaN', '1.2.3'];

        it('borrow rejects every non-fixed-notation spelling of amount', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            for (const v of BAD) {
                const r = await borrow(ALICE, v);
                assert.strictEqual(r.success, false, `borrow(${JSON.stringify(v)}) must not succeed`);
                assert.strictEqual(r.emittedActions.length, 0,
                    `borrow(${JSON.stringify(v)}) must emit nothing`);
            }
            // Nothing was booked by any of them.
            assertContractState(h.ledger, ADDR, 'totalDebt', '0');
            assertBalance(h.ledger, ALICE, STABLE, '0');
            // And the plain-decimal gate, not some incidental mathjs throw, is what
            // stopped the one spelling that used to slip all the way through.
            assertReverted(await borrow(ALICE, '1.5e-8'), 'plain decimal');
        });

        it('withdraw rejects every non-fixed-notation spelling of amount', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            for (const v of BAD) {
                const r = await withdraw(ALICE, v);
                assert.strictEqual(r.success, false, `withdraw(${JSON.stringify(v)}) must not succeed`);
                assert.strictEqual(r.emittedActions.length, 0,
                    `withdraw(${JSON.stringify(v)}) must emit nothing`);
            }
            assertContractState(h.ledger, ADDR, 'trackedColl', '3');
            assertContractState(h.ledger, ADDR, 'v:' + ALICE + ':coll', '3');
            assertReverted(await withdraw(ALICE, '1.5e-8'), 'plain decimal');
        });

        // The gate is notation only. A legitimately-spelled amount that is merely
        // off the tick's decimal grid must still go through and be FLOORED, or
        // the fix would have replaced a silent shortfall with a lockout.
        it('still accepts ordinary fixed notation, off-grid values included', async function () {
            await deployVault();
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            for (const v of ['1', '0.5', '100.00', '0.000000015']) {
                assertSuccess(await borrow(ALICE, v), `borrow(${JSON.stringify(v)}) must succeed`);
            }
            // 1 + 0.5 + 100 + floor(0.000000015) = 101.50000001, all on the grid.
            assertContractState(h.ledger, ADDR, 'totalDebt', '101.50000001');
            assertBalance(h.ledger, ALICE, STABLE, '101.50000001');
            assertContractBalance(h.ledger, ADDR, STABLE, '0');
        });
    });

    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(ALICE, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: ALICE, contractAddress: 'C:BTC:2', params: params });
        }

        it('rejects a ratio at/below 100% and identical collateral/stable ticks', async function () {
            const low = await deployWith([COLL, STABLE, PAIR, '100', BONUS, MAXAGE]);
            assert.strictEqual(low.success, false, 'minRatioPct=100 should revert in initialize');
            const same = await deployWith([COLL, COLL, PAIR, RATIO, BONUS, MAXAGE]);
            assert.strictEqual(same.success, false, 'collateral == stable should revert in initialize');
        });
    });
});
