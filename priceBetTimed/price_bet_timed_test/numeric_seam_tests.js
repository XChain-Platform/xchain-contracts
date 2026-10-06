'use strict';

module.exports = function registerNumericSeamTests(context) {
    const {
        ADDR, MAKER, TAKER, TICK, PAIR, STRIKE, T, CODE, XChainVM, E2EHarness, assertSuccess,
        assertReverted, assertContractState, h, setHarness, seedTipRound, depositAnd
    } = context;

    describe('attacks we considered: numeric seam', function () {
        // A 1,000,000 stake puts one 8-dp base unit inside the tolerant gte band.
        it('fund() and accept() are exact to the base unit on a large stake', async function () {
            setHarness(new E2EHarness(XChainVM));
            h.seedBalance(MAKER, 'XCHAIN', '1000000');
            h.seedBalance(MAKER, TICK, '1000000');
            h.seedBalance(TAKER, TICK, '1000000');
            h.ledger.setTokenDecimals(TICK, 8);
            assertSuccess(await h.deploy({ code: CODE, deployer: MAKER, contractAddress: ADDR,
                params: [MAKER, PAIR, STRIKE, 'OVER', TICK, '1000000', String(T), '5'] }));
            seedTipRound();
            assertReverted(await depositAnd(MAKER, 'fund', '999999.99999999'), 'insufficient deposit');
            assertSuccess(await depositAnd(MAKER, 'fund', '0.00000001'));
            assertReverted(await depositAnd(TAKER, 'accept', '999999.99999999'), 'insufficient deposit');
            assertSuccess(await depositAnd(TAKER, 'accept', '0.00000001'));
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
        });
    });

    registerNearStrikeSettlementTests(context);
};

// A tolerant math.eq read a price one base unit off a 60000 strike as equal (1e-12 relative).
function registerNearStrikeSettlementTests(context) {
    const {
        ADDR, MAKER, TAKER, TICK, T, assert, assertSuccess, assertBalance, assertContractState,
        h, deployBet, depositAnd, publishRounds, settleBy, returned
    } = context;

    describe('attacks we considered: near-strike settlement is exact', function () {
        async function settleAt(side, price) {
            await deployBet(side);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 50, price: price } });
            const r = await settleBy();
            assertSuccess(r);
            return returned(r);
        }

        it('one base unit above the strike: OVER maker wins, no push', async function () {
            assert.strictEqual(await settleAt('OVER', '60000.00000001'), 'SETTLED');
            assertContractState(h.ledger, ADDR, 'winner', MAKER);
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('one base unit below the strike: OVER maker loses to the taker', async function () {
            assert.strictEqual(await settleAt('OVER', '59999.99999999'), 'SETTLED');
            assertContractState(h.ledger, ADDR, 'winner', TAKER);
            assertBalance(h.ledger, TAKER, TICK, '200');
        });

        it('one base unit below the strike: UNDER maker wins', async function () {
            assert.strictEqual(await settleAt('UNDER', '59999.99999999'), 'SETTLED');
            assertContractState(h.ledger, ADDR, 'winner', MAKER);
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('a differently spelled equal price still pushes', async function () {
            assert.strictEqual(await settleAt('OVER', '60000.000'), 'PUSH');
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
        });
    });
}
