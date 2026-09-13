// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// dutchAuction.test.js: behavioral + adversarial tests for dutchAuction.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL dutchAuction.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/dutchAuction/dutchAuction.test.js

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
} catch (e) { XChainVM = null; console.log('Skipping dutchAuction tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'dutchAuction.js'), 'utf8');

const SELLER = 'seller';
const ITEM   = 'ITEM';
const BID    = 'TEST';
const ADDR   = 'C:BTC:1';

(XChainVM ? describe : describe.skip)('Template: dutchAuction', function () {
    this.timeout(0);
    let h;

    // Deploy a fresh auction: 10 ITEM for sale, price 1000 -> 100 TEST over
    // `duration` blocks (0-decimal TEST so the linear price grid is exact).
    async function deployAuction(duration) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(SELLER, 'XCHAIN', '1000000');
        h.seedBalance(SELLER, ITEM, '10');
        h.ledger.setTokenDecimals(BID, 0);
        // fund() reads itemTick's decimals to check the amount lands on its grid, and
        // the harness's decimals registry is balance-INDEPENDENT (MockLedger) while a
        // node's is not: the indexer builds balances and tokenInfo from ONE snapshot
        // over SOURCE + the contract address (db.js buildVmBalancesAndTokenInfo), so a
        // tick the contract holds a just-DEPOSITed amount of always carries its info
        // in the same snapshot getBalance reads. Seeding the item tick models that
        // reachability; it is not the stableVault trap of seeding a tick nobody holds.
        h.ledger.setTokenDecimals(ITEM, 0);
        await h.deploy({
            code: CODE, deployer: SELLER, contractAddress: ADDR,
            params: [SELLER, ITEM, '10', BID, '1000', '100', String(duration || 10)]
        });
    }

    // Same-batch fund: deposit the item then fund(). Mirrors BATCH(DEPOSIT, EXECUTE("fund")).
    async function depositAndFund() {
        h.deposit(SELLER, ADDR, ITEM, '10');
        return h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER });
    }

    // Same-batch buy: fund the buyer, deposit `pay` of BID, then buy(). Mirrors
    // BATCH(DEPOSIT, EXECUTE("buy")).
    async function buy(buyer, pay) {
        h.seedBalance(buyer, BID, pay);
        h.deposit(buyer, ADDR, BID, pay);
        return h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: buyer });
    }

    describe('happy paths', function () {
        it('buying at deploy-time price (block 0 elapsed) charges startPrice', async function () {
            await deployAuction(10);
            await depositAndFund(); // fund() lands the block right after deploy; elapsed = 0
            const r = await buy('alice', '1000');
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'alice', tick: ITEM, quantity: '10' } },
                { action: 'SEND', params: { destination: SELLER, tick: BID, quantity: '1000' } }
            ]);
            assertBalance(h.ledger, 'alice', ITEM, '10');
            assertBalance(h.ledger, SELLER, BID, '1000');
            assertContractState(h.ledger, ADDR, 'status', 'SOLD');
        });

        it('the price decays linearly with elapsed blocks', async function () {
            await deployAuction(10); // 1000 -> 100 over 10 blocks = 90/block
            await depositAndFund();
            h.mineBlock(); h.mineBlock(); h.mineBlock(); // elapsed = 3 -> price 1000 - 270 = 730
            assertReverted(await buy('alice', '700'), 'insufficient payment for the current price (730)');
            const r = await buy('alice', '730');
            assertSuccess(r);
            assertBalance(h.ledger, SELLER, BID, '730');
        });

        it('overpaying refunds the excess in the same call', async function () {
            await deployAuction(10);
            await depositAndFund();
            const r = await buy('alice', '1000'); // price is 1000 at elapsed=0; no excess
            assertSuccess(r);
            assertContractBalance(h.ledger, ADDR, BID, '0');

            await deployAuction(10);
            await depositAndFund();
            const r2 = await buy('bob', '1500'); // overpay by 500
            assertSuccess(r2);
            assertEmittedActions(r2, [
                { action: 'SEND', params: { destination: 'bob', tick: ITEM, quantity: '10' } },
                { action: 'SEND', params: { destination: SELLER, tick: BID, quantity: '1000' } },
                { action: 'SEND', params: { destination: 'bob', tick: BID, quantity: '500' } }
            ]);
            assertBalance(h.ledger, 'bob', BID, '500'); // 1500 sent - 1000 charged = 500 back
        });

        it('the price floors at endPrice and holds there indefinitely', async function () {
            await deployAuction(10);
            await depositAndFund();
            for (let i = 0; i < 50; i++) h.mineBlock(); // way past duration
            assertReverted(await buy('alice', '99'), 'insufficient payment for the current price (100)');
            const r = await buy('alice', '100');
            assertSuccess(r);
            assertBalance(h.ledger, SELLER, BID, '100');
        });

        it('seller cancels before any purchase and reclaims the item', async function () {
            await deployAuction(10);
            await depositAndFund();
            h.mineBlock();
            const r = await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(r);
            assertBalance(h.ledger, SELLER, ITEM, '10');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });
    });

    describe('attacks we considered', function () {
        it('fund() rejects an underfunded item deposit', async function () {
            await deployAuction(10);
            h.deposit(SELLER, ADDR, ITEM, '5');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
                'insufficient item deposit');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
        });

        it('only the seller can fund or cancel', async function () {
            await deployAuction(10);
            h.seedBalance('stranger', ITEM, '10');
            h.deposit('stranger', ADDR, ITEM, '10');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: 'stranger' }),
                'only the seller');
            await depositAndFund();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
                'only the seller');
        });

        it('an underpaying buy() is rejected and the deposit stays in custody', async function () {
            await deployAuction(10);
            await depositAndFund();
            assertReverted(await buy('alice', '500'), 'insufficient payment');
            assertContractState(h.ledger, ADDR, 'status', 'ACTIVE');
            assertContractBalance(h.ledger, ADDR, BID, '500'); // stuck until a corrected buy()
        });

        it('a second buy() after a sale is rejected: single-shot settlement', async function () {
            await deployAuction(10);
            await depositAndFund();
            assertSuccess(await buy('alice', '1000'));
            assertReverted(await buy('bob', '1000'), 'not active');
            assertContractBalance(h.ledger, ADDR, ITEM, '0'); // no double-payout
        });

        it('cancel() is rejected once the item is sold', async function () {
            await deployAuction(10);
            await depositAndFund();
            await buy('alice', '1000');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
                'not cancellable');
        });

        it('buying before funding reverts', async function () {
            await deployAuction(10);
            assertReverted(await buy('alice', '1000'), 'not active');
        });

        // The price leg above is floored onto bidTick's grid; the ITEM leg was never
        // checked at all. buy() and cancel() emit itemAmount verbatim and the indexer
        // re-quantises every emitted amount onto its tick's grid at write time, so an
        // off-grid item silently normalises - to ZERO on a 0-decimal tick, which is a
        // VALID SEND that moves nothing. The buyer would pay in full, receive nothing,
        // and the deposit would sit in a SOLD auction out of cancel()'s reach, so the
        // gate belongs at fund(), before the auction arms.
        async function deployOffGridItem(itemAmount) {
            h = new E2EHarness(XChainVM);
            h.seedBalance(SELLER, 'XCHAIN', '1000000');
            h.seedBalance(SELLER, ITEM, '10');
            h.ledger.setTokenDecimals(BID, 0);
            h.ledger.setTokenDecimals(ITEM, 0);
            return h.deploy({
                code: CODE, deployer: SELLER, contractAddress: ADDR,
                params: [SELLER, ITEM, itemAmount, BID, '1000', '100', '10']
            });
        }

        it('fund() rejects an itemAmount that is off the item tick grid', async function () {
            assertSuccess(await deployOffGridItem('0.25'));
            h.deposit(SELLER, ADDR, ITEM, '10');
            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
                'not representable at itemTick decimals');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
            // Never armed, so no buy.
            assertReverted(await buy('alice', '1000'), 'not active');
            // The rejecting fund() did NOT roll back the deposit, so cancel() from
            // the pre-funded state is the seller's recovery path. It returns the
            // HELD balance, not the off-grid itemAmount the ledger would re-quantise
            // to nothing.
            const c = await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(c);
            assertEmittedActions(c, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '10' } }]);
            assertBalance(h.ledger, SELLER, ITEM, '10');
            assertContractBalance(h.ledger, ADDR, ITEM, '0');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('cancel() returns a short deposit after fund() rejected it', async function () {
            await deployAuction(10);
            h.deposit(SELLER, ADDR, ITEM, '5');
            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
                'insufficient item deposit');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
            const c = await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(c);
            assertEmittedActions(c, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '5' } }]);
            assertBalance(h.ledger, SELLER, ITEM, '10');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('a stranger cannot cancel() a pre-funded auction', async function () {
            await deployAuction(10);
            h.deposit(SELLER, ADDR, ITEM, '10');
            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
                'only the seller');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
        });

        it('cancel() on a contract holding nothing reverts rather than latching CANCELLED', async function () {
            await deployAuction(10);
            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
                'nothing to reclaim');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
            assertSuccess(await depositAndFund());
            assertContractState(h.ledger, ADDR, 'status', 'ACTIVE');
        });

        it('an off-grid itemAmount above one unit is rejected too, not rounded up', async function () {
            assertSuccess(await deployOffGridItem('2.5'));
            h.deposit(SELLER, ADDR, ITEM, '10');
            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
                'not representable at itemTick decimals');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
        });

        // The control the gate needs: a gate that reverted every fund() would look
        // identical to a gate that caught the defect.
        it('an on-grid itemAmount still funds, sells and delivers the exact quantity', async function () {
            await deployAuction(10);
            assertSuccess(await depositAndFund());
            assertSuccess(await buy('alice', '1000'));
            assertBalance(h.ledger, 'alice', ITEM, '10');
        });

        // A sub-grid endPrice deploys clean (the constructor gates notation and
        // magnitude, never the grid), so the decayed asking price can floor to '0'
        // on bidTick. Without the post-floor positivity guard, gte(held, '0')
        // admits a caller who deposited nothing, the seller is paid an AMOUNT=0
        // no-op and the auction latches SOLD out of cancel()'s reach.
        it('a sub-grid asking price reverts instead of selling the item for nothing', async function () {
            h = new E2EHarness(XChainVM);
            h.seedBalance(SELLER, 'XCHAIN', '1000000');
            h.seedBalance(SELLER, ITEM, '10');
            h.ledger.setTokenDecimals(BID, 0);
            h.ledger.setTokenDecimals(ITEM, 0);   // see deployAuction: fund() reads the item grid
            await h.deploy({
                code: CODE, deployer: SELLER, contractAddress: ADDR,
                params: [SELLER, ITEM, '10', BID, '1000', '0.5', '10']
            });
            await depositAndFund();
            for (let i = 0; i < 50; i++) h.mineBlock(); // past duration: price is endPrice 0.5, which floors to '0'

            assertReverted(
                await h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: 'mallory' }),
                'below one unit of the bid tick');
            assertContractState(h.ledger, ADDR, 'status', 'ACTIVE');
            assertContractBalance(h.ledger, ADDR, ITEM, '10');
            assertBalance(h.ledger, 'mallory', ITEM, '0');
        });
    });

    describe('deploy-time validation', function () {
        it('rejects itemTick === bidTick', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:2',
                params: [SELLER, BID, '10', BID, '1000', '100', '10']
            });
            assert.strictEqual(r.success, false, 'deploy with itemTick === bidTick should revert');
        });

        it('rejects startPrice <= endPrice', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:3',
                params: [SELLER, ITEM, '10', BID, '100', '100', '10']
            });
            assert.strictEqual(r.success, false, 'deploy with startPrice === endPrice should revert');
        });

        it('rejects a non-positive durationBlocks', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:4',
                params: [SELLER, ITEM, '10', BID, '1000', '100', '0']
            });
            assert.strictEqual(r.success, false, 'deploy with durationBlocks=0 should revert');
        });

        // durationBlocks is raw deployer text. A radix-less parseInt would measure
        // '1e3' as 1 and arm a 1-block decay the seller never asked for, so the
        // constructor shape-checks it (requireIntInRange) instead.
        it('rejects a durationBlocks that is not a canonical integer', async function () {
            const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99',
                         '1_000', '+7', '', 'abc', '-', 'Infinity', 'NaN',
                         '-5', '1000001'];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                bad.seedBalance(SELLER, 'XCHAIN', '1000000');
                const r = await bad.deploy({
                    code: CODE, deployer: SELLER, contractAddress: 'C:BTC:9',
                    params: [SELLER, ITEM, '10', BID, '1000', '100', BAD[i]]
                });
                assert.strictEqual(r.success, false,
                    'deploy with durationBlocks ' + JSON.stringify(BAD[i]) + ' should revert');
            }
        });

        it('accepts a canonical durationBlocks and stores it verbatim', async function () {
            const ok = new E2EHarness(XChainVM);
            ok.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await ok.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:5',
                params: [SELLER, ITEM, '10', BID, '1000', '100', '1000']
            });
            assertSuccess(r);
            assertContractState(ok.ledger, 'C:BTC:5', 'duration', '1000');
        });

        // startPrice/endPrice are raw deployer text and xchain.math accepts every
        // spelling mathjs parses, so the magnitude checks are no filter. endPrice
        // reaches floorToDecimals unchanged once the decay window has elapsed, and
        // that helper CORRUPTS an exotic spelling rather than no-opping on it
        // ('1.23456789e2' -> '1.23456789', a 1% payout). Gate the notation at the door.
        it('rejects a startPrice or endPrice that is not a plain fixed-notation decimal', async function () {
            const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                         '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                         'Infinity', 'NaN', '1.2.3', '10abc', ' 10'];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                bad.seedBalance(SELLER, 'XCHAIN', '1000000');
                const r = await bad.deploy({
                    code: CODE, deployer: SELLER, contractAddress: 'C:BTC:10',
                    params: [SELLER, ITEM, '10', BID, '1000', BAD[i], '10']
                });
                assert.strictEqual(r.success, false,
                    'deploy with endPrice ' + JSON.stringify(BAD[i]) + ' should revert');
            }

            const badStart = new E2EHarness(XChainVM);
            badStart.seedBalance(SELLER, 'XCHAIN', '1000000');
            const rs = await badStart.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:11',
                params: [SELLER, ITEM, '10', BID, '1e4', '100', '10']
            });
            assert.strictEqual(rs.success, false, "deploy with startPrice '1e4' should revert");
        });

        // The gate is notation-only, NOT a grid check: an off-grid but legitimately
        // spelled price still deploys and is stored verbatim, because bidTick's
        // decimals are unreadable at deploy time and buy() floors onto them instead.
        it('accepts an off-grid but plainly spelled endPrice and stores it verbatim', async function () {
            const ok = new E2EHarness(XChainVM);
            ok.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await ok.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:12',
                params: [SELLER, ITEM, '10', BID, '1000', '100.123456789', '10']
            });
            assertSuccess(r);
            assertContractState(ok.ledger, 'C:BTC:12', 'endPrice', '100.123456789');
        });

        // itemAmount reaches floorToDecimals at fund() and is emitted verbatim at
        // buy()/cancel(), so it needs the same notation gate the price terms have:
        // on '2.5e-2' the floor is a no-op and the grid check would bless an amount
        // the ledger reads as 0.025.
        it('rejects an itemAmount that is not a plain fixed-notation decimal', async function () {
            const BAD = ['2.5e-2', '1e3', '0x10', '+1.5', '.5', '5.', '1_000',
                         '1.2.3', '', ' 10', 'abc', '-10'];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                bad.seedBalance(SELLER, 'XCHAIN', '1000000');
                const r = await bad.deploy({
                    code: CODE, deployer: SELLER, contractAddress: 'C:BTC:13',
                    params: [SELLER, ITEM, BAD[i], BID, '1000', '100', '10']
                });
                assert.strictEqual(r.success, false,
                    'deploy with itemAmount ' + JSON.stringify(BAD[i]) + ' should revert');
            }
        });

        it('accepts an off-grid but plainly spelled itemAmount and stores it verbatim', async function () {
            const ok = new E2EHarness(XChainVM);
            ok.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await ok.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:14',
                params: [SELLER, ITEM, '0.25', BID, '1000', '100', '10']
            });
            assertSuccess(r);
            assertContractState(ok.ledger, 'C:BTC:14', 'itemAmount', '0.25');
        });
    });
});
