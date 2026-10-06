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
const registerOffGridPaymentTests = require('./crowdsale_test/off_grid_payments');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertBalance,
    assertContractBalance;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertBalance, assertContractBalance }
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
        // A held tick always carries token info on a real node; buy() reads it for change.
        h.ledger.setTokenDecimals(PAY, 8);
        return h.deploy({
            code: CODE, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, PAY, SALE, over.rate || RATE, over.soft || SOFT, over.hard || HARD,
                     String(DURATION), '8']
        });
    }
    // Same-batch pay: DEPOSIT then buy(), mirroring BATCH(DEPOSIT, EXECUTE("buy")).
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
            h.ledger.setTokenDecimals(PAY, 8);
            assertSuccess(await h.deploy({
                code: CODE, deployer: OWNER, contractAddress: ADDR,
                params: [OWNER, PAY, SALE, '10', '1', '200', String(DURATION), '0'] // rate 10, soft 1, hard 200, saleDecimals 0
            }));
            // paid 10.15 -> 101.5 tokens: buy() keeps 10.1 (101 whole tokens) and returns 0.05.
            const b = await buy(B1, '10.15');
            assertSuccess(b);
            assertEmittedActions(b, [{ action: 'SEND', params: { destination: B1, tick: PAY, quantity: '0.05' } }]);
            close();
            assertSuccess(await call('finalize', B1));

            const c = await call('claim', B1);
            assertSuccess(c);
            // Floored DOWN to the 0dp grid -> '101', never the half-up round-up '102'
            // (and never the unfloored '101.5' the indexer would re-normalise upward).
            assertEmittedActions(c, [{ action: 'MINT', params: { tick: SALE, quantity: '101', destination: B1 } }]);
        });
    });

    // Pin exact caps: a tolerant lte (relTol 1e-12) lets a buy pass a 100000 cap by up
    // to 10 base units, so the claims exceed the exact MAX_SUPPLY and the last is stranded.
    describe('exact cap comparisons (no mathjs tolerance)', function () {
        async function deployBig(soft, hard) {
            assertSuccess(await deploy({ rate: '1', soft, hard }));
            for (const a of [B1, B2]) h.seedBalance(a, PAY, '300000');
        }

        it('rejects a buy that overshoots the hard cap by less than one tolerance band', async function () {
            await deployBig('1', '100000');
            assertReverted(await buy(B1, '100000.00000005'), 'hard cap exceeded');
        });

        it('still accepts a buy that lands exactly on the hard cap, and finalizes early', async function () {
            await deployBig('1', '100000');
            assertSuccess(await buy(B1, '100000'));
            assertSuccess(await call('finalize', B1));
        });

        it('one base unit short of the hard cap does not allow an early finalize', async function () {
            await deployBig('1', '100000');
            assertSuccess(await buy(B1, '99999.99999999'));
            assertReverted(await call('finalize', B1), 'sale still open');
        });

        it('one base unit short of the soft cap finalizes FAILED and refunds in full', async function () {
            await deployBig('100000', '200000');
            assertSuccess(await buy(B1, '99999.99999999'));
            close();
            assertSuccess(await call('finalize', B1));
            assertReverted(await call('claim', B1), 'sale not successful');
            const r = await call('refund', B1);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: B1, tick: PAY, quantity: '99999.99999999' } }]);
        });

        it('initialize rejects a hardCap one base unit below softCap', async function () {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(OWNER, 'XCHAIN', '1000000');
            const res = await b.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
                params: [OWNER, PAY, SALE, '1', '100000', '99999.99999999', '50', '8'] });
            assert.strictEqual(res.success, false);
            assert(String(res.error).includes('hardCap must be >= softCap'), 'got: ' + res.error);
        });

        // A softCap of 'Infinity' would otherwise finalize SUCCESS for any raise and strand every refund.
        it('initialize rejects a non-finite softCap or hardCap', async function () {
            for (const [soft, hard] of [['Infinity', '100'], ['100', 'Infinity'], ['100', 'NaN']]) {
                const b = new E2EHarness(XChainVM);
                b.seedBalance(OWNER, 'XCHAIN', '1000000');
                const res = await b.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
                    params: [OWNER, PAY, SALE, '1', soft, hard, '50', '8'] });
                assert.strictEqual(res.success, false, 'softCap ' + soft + ' / hardCap ' + hard + ' deployed');
                assert(String(res.error).includes('hardCap must be >= softCap'), 'got: ' + res.error);
            }
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

        // durationBlocks gets the same integer-SHAPE gate saleDecimals gets, and
        // for the same reason: it is raw deployer text burned into the permanent
        // `deadline` key, and a radix-less parseInt re-measures it ('1e3' -> 1,
        // '0x10' -> 16, '5.99' -> 5, ' 5' -> 5, '+5' -> 5, '5abc' -> 5). A sale
        // the DEPLOY action advertises as 1000 blocks would open for one: buy()
        // rejects every later contribution and finalize() latches FAILED for want
        // of the soft cap.
        it('rejects a durationBlocks a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e3', '0x10', '5.99', ' 5', '+5', '5abc', '1_000',
                         '', 'abc', 'Infinity', 'NaN', '0', '-1'];
            for (const v of BAD) {
                assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, v, '8'])).success,
                    false, `durationBlocks ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('accepts the durationBlocks window bounds and stores the value verbatim', async function () {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '1', '8'])).success, true);
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '1000000', '8'])).success, true);
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '1000001', '8'])).success, false);

            // '1000' means 1000 blocks in the deadline, not the 1 a parseInt of
            // '1e3' gave. The harness deploys at height 1.
            const b4 = new E2EHarness(XChainVM);
            b4.seedBalance(OWNER, 'XCHAIN', '1000000');
            const r = await b4.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
                params: [OWNER, PAY, SALE, RATE, SOFT, HARD, '1000', '8'] });
            assert.strictEqual(r.success, true);
            assert.strictEqual(b4.ledger.getContractStateKey('C:BTC:9', 'deadline'), '1001');
        });
    });

    registerOffGridPaymentTests({
        OWNER, B1, B2, ADDR, PAY, SALE, CODE, XChainVM, E2EHarness, assert, assertSuccess,
        assertReverted, assertEmittedActions, assertBalance, assertContractBalance
    });
});
