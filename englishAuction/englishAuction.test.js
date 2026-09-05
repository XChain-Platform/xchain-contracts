// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// englishAuction.test.js: behavioral + adversarial tests for englishAuction.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL englishAuction.js template (no copy), so the test can never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/englishAuction/englishAuction.test.js

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
} catch (e) { XChainVM = null; console.log('Skipping englishAuction tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'englishAuction.js'), 'utf8');

const SELLER = 'seller';
const ITEM   = 'ITEM';
const BID    = 'TEST';
const ADDR   = 'C:BTC:1';

(XChainVM ? describe : describe.skip)('Template: englishAuction', function () {
    this.timeout(0);
    let h;

    // Deploy a fresh auction: 10 ITEM for sale, min bid 50 TEST, `window` blocks.
    async function deployAuction(window) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(SELLER, 'XCHAIN', '1000000');
        h.seedBalance(SELLER, ITEM, '10');
        await h.deploy({
            code: CODE, deployer: SELLER, contractAddress: ADDR,
            params: [SELLER, ITEM, '10', BID, '50', String(window || 5)]
        });
    }

    // Same-batch fund: deposit the item then fund(). Mirrors BATCH(DEPOSIT, EXECUTE("fund")).
    async function depositAndFund(amount) {
        h.deposit(SELLER, ADDR, ITEM, amount || '10');
        return h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER });
    }

    // Same-batch bid: fund the bidder, deposit, then bid(). Mirrors
    // BATCH(DEPOSIT, EXECUTE("bid")).
    async function bid(bidder, amount) {
        h.seedBalance(bidder, BID, amount);
        h.deposit(bidder, ADDR, BID, amount);
        return h.execute({ contractAddress: ADDR, method: 'bid', params: [], caller: bidder });
    }

    describe('happy paths', function () {
        it('a single bidder wins the item and the seller is paid, after the deadline', async function () {
            await deployAuction(3);
            assertSuccess(await depositAndFund());
            assertContractState(h.ledger, ADDR, 'status', 'ACTIVE');

            assertSuccess(await bid('alice', '50'));
            assertContractState(h.ledger, ADDR, 'highBidder', 'alice');
            assertContractState(h.ledger, ADDR, 'highBid', '50');

            h.mineBlock(); h.mineBlock(); h.mineBlock();
            const r = await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertEmittedActions(r, [
                { action: 'SEND', params: { destination: 'alice', tick: ITEM, quantity: '10' } },
                { action: 'SEND', params: { destination: SELLER, tick: BID, quantity: '50' } }
            ]);
            assertBalance(h.ledger, 'alice', ITEM, '10');
            assertBalance(h.ledger, SELLER, BID, '50');
            assertContractBalance(h.ledger, ADDR, ITEM, '0');
            assertContractBalance(h.ledger, ADDR, BID, '0');
            assertContractState(h.ledger, ADDR, 'status', 'SOLD');
        });

        it('a higher bid instantly refunds the previous leader', async function () {
            await deployAuction();
            await depositAndFund();
            assertSuccess(await bid('alice', '50'));
            const r = await bid('bob', '80');
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: 'alice', tick: BID, quantity: '50' } }]);
            assertBalance(h.ledger, 'alice', BID, '50'); // fully refunded
            assertContractBalance(h.ledger, ADDR, BID, '80'); // only bob's stake held
            assertContractState(h.ledger, ADDR, 'highBidder', 'bob');
            assertContractState(h.ledger, ADDR, 'highBid', '80');
        });

        it('multiple raises settle correctly: item to the final leader, bid to the seller', async function () {
            await deployAuction(3);
            await depositAndFund();
            await bid('alice', '50');
            await bid('bob', '80');
            await bid('carol', '120');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            const r = await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertBalance(h.ledger, 'carol', ITEM, '10');
            assertBalance(h.ledger, SELLER, BID, '120');
            assertBalance(h.ledger, 'alice', BID, '50'); // refunded when outbid by bob
            assertBalance(h.ledger, 'bob', BID, '80'); // refunded when outbid by carol
        });

        it('no bids: settle() returns the item to the seller (UNSOLD)', async function () {
            await deployAuction(3);
            await depositAndFund();
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            const r = await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' });
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '10' } }]);
            assertBalance(h.ledger, SELLER, ITEM, '10');
            assertContractState(h.ledger, ADDR, 'status', 'UNSOLD');
        });

        it('seller cancels before any bid and reclaims the item', async function () {
            await deployAuction();
            await depositAndFund();
            const r = await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
            assertSuccess(r);
            assertBalance(h.ledger, SELLER, ITEM, '10');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });
    });

    describe('attacks we considered', function () {
        it('fund() rejects an underfunded item deposit', async function () {
            await deployAuction();
            assertReverted(await depositAndFund('5'), 'insufficient item deposit');
            assertContractState(h.ledger, ADDR, 'status', 'INIT');
        });

        it('only the seller can fund or cancel', async function () {
            await deployAuction();
            h.seedBalance('stranger', ITEM, '10');
            h.deposit('stranger', ADDR, ITEM, '10');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: 'stranger' }),
                'only the seller');
            await depositAndFund();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
                'only the seller');
        });

        it('a bid below the minimum is rejected', async function () {
            await deployAuction();
            await depositAndFund();
            assertReverted(await bid('alice', '10'), 'below the minimum');
            assertContractState(h.ledger, ADDR, 'highBid', '0');
        });

        it('a bid that does not exceed the current high bid is rejected', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '80');
            assertReverted(await bid('bob', '80'), 'must exceed the current high bid');
            assertContractState(h.ledger, ADDR, 'highBidder', 'alice');
        });

        it('the current leader cannot raise their own bid', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await bid('alice', '100'), 'already the high bidder');
        });

        // Pins the documented COST of the no-self-raise rule (README, "A rejected
        // bid's DEPOSIT is not rolled back"). BATCH is not all-or-nothing, so the
        // top-up behind a reverting bid() settles anyway and the delta accounting
        // hands it to the NEXT bidder. A future change that refunds or credits it
        // instead must rewrite this test together with that README entry, not
        // delete it.
        it('a rejected bid strands its batched DEPOSIT, and the next bidder inherits it', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await bid('alice', '100'), 'already the high bidder');
            assertContractBalance(h.ledger, ADDR, BID, '150');   // alice's 100 settled anyway

            // bob deposits 10 and is credited 110: alice's stranded top-up plus his own.
            assertSuccess(await bid('bob', '10'));
            assertContractState(h.ledger, ADDR, 'highBidder', 'bob');
            assertContractState(h.ledger, ADDR, 'highBid', '110');
            assertBalance(h.ledger, 'alice', BID, '50');         // her 50 stake back, never the 100
        });

        it('bidding after the deadline is rejected; settle() is the only path', async function () {
            await deployAuction(2);
            await depositAndFund();
            h.mineBlock(); h.mineBlock();
            assertReverted(await bid('alice', '50'), 'bidding closed');
        });

        it('settle() before the deadline is rejected', async function () {
            await deployAuction(5);
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }),
                'deadline not reached');
        });

        it('cancel() is rejected once a bid has been placed', async function () {
            await deployAuction();
            await depositAndFund();
            await bid('alice', '50');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
                'a bid has already been placed');
        });

        it('double-settle is impossible: second settle() reverts on the status guard', async function () {
            await deployAuction(2);
            await depositAndFund();
            await bid('alice', '50');
            h.mineBlock(); h.mineBlock();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }));
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'settle', params: [], caller: 'anyone' }),
                'not active');
        });

        it('bidding before funding reverts', async function () {
            await deployAuction();
            assertReverted(await bid('alice', '50'), 'not active');
        });
    });

    describe('deploy-time validation', function () {
        it('rejects itemTick === bidTick', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:2',
                params: [SELLER, BID, '10', BID, '50', '5']
            });
            assert.strictEqual(r.success, false, 'deploy with itemTick === bidTick should revert');
        });

        it('rejects a non-positive minBid', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:3',
                params: [SELLER, ITEM, '10', BID, '0', '5']
            });
            assert.strictEqual(r.success, false, 'deploy with minBid=0 should revert');
        });

        // deadlineBlocks is raw deployer text. A radix-less parseInt would measure
        // '1e3' as 1 and arm a 1-block auction the seller never asked for, so the
        // constructor shape-checks it (requireIntInRange) instead.
        it('rejects a deadlineBlocks that is not a canonical integer', async function () {
            const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99',
                         '1_000', '+7', '', 'abc', '-', 'Infinity', 'NaN', '0',
                         '-5', '1000001'];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                bad.seedBalance(SELLER, 'XCHAIN', '1000000');
                const r = await bad.deploy({
                    code: CODE, deployer: SELLER, contractAddress: 'C:BTC:9',
                    params: [SELLER, ITEM, '10', BID, '50', BAD[i]]
                });
                assert.strictEqual(r.success, false,
                    'deploy with deadlineBlocks ' + JSON.stringify(BAD[i]) + ' should revert');
            }
        });

        it('accepts a canonical deadlineBlocks and stores it verbatim', async function () {
            const ok = new E2EHarness(XChainVM);
            ok.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await ok.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:4',
                params: [SELLER, ITEM, '10', BID, '50', '1000']
            });
            assertSuccess(r);
            assertContractState(ok.ledger, 'C:BTC:4', 'window', '1000');
        });
    });
});
