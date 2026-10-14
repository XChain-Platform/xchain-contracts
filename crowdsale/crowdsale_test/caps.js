'use strict';

// Precision and exact cap comparisons.

function registerPrecisionTests(ctx, kit) {
    const { OWNER, B1, B2, ADDR, PAY, SALE, CODE, XChainVM, E2EHarness, DURATION, assert,
            assertSuccess, assertReverted, assertEmittedActions } = ctx;
    const { deploy, buy, call, close } = kit;

    describe('precision (indexer half-up round-up over-issuance)', function () {
        it('floors the claim mint onto the saleTick decimal grid instead of over-issuing', async function () {
            // saleTick has 0 decimals; a contribution whose paid*rate lands on .5 would
            // half-up round UP at ledger-write (101.5 -> 102), delivering more than paid*rate
            // and eventually past custody. The contract must EMIT the floored '101'.
            kit.h = new E2EHarness(XChainVM);
            for (const a of [OWNER, B1]) { kit.h.seedBalance(a, 'XCHAIN', '1000000'); kit.h.seedBalance(a, PAY, '500'); }
            kit.h.ledger.setTokenDecimals(PAY, 8);
            assertSuccess(await kit.h.deploy({
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
            assertEmittedActions(c, [{ action: 'SEND', params: { tick: SALE, quantity: '101', destination: B1 } }]);
        });
    });
}

function makeDeployBig(ctx, kit) {
    return async function deployBig(soft, hard) {
        ctx.assertSuccess(await kit.deploy({ rate: '1', soft, hard }));
        for (const a of [ctx.B1, ctx.B2]) kit.h.seedBalance(a, ctx.PAY, '300000');
    };
}

// Pin exact caps: a tolerant lte (relTol 1e-12) lets a buy pass a 100000 cap by up
// to 10 base units, so the claims exceed the exact MAX_SUPPLY and the last is stranded.
function registerExactCapTests(ctx, kit) {
    const { OWNER, B1, B2, ADDR, PAY, SALE, CODE, XChainVM, E2EHarness, assert,
            assertSuccess, assertReverted, assertEmittedActions } = ctx;
    const { deploy, buy, call, close } = kit;
    const deployBig = makeDeployBig(ctx, kit);

    describe('exact cap comparisons (no mathjs tolerance)', function () {
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
}

function registerCapTests(ctx, kit) {
    registerPrecisionTests(ctx, kit);
    registerExactCapTests(ctx, kit);
}

module.exports = registerCapTests;
