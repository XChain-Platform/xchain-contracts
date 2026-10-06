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
};
