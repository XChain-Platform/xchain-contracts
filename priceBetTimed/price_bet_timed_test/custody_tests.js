'use strict';

module.exports = function registerCustodyTests(context) {
    const {
        ADDR, MAKER, TAKER, STRANGER, TICK, T, assertSuccess, assertReverted, assertContractBalance,
        h, deployBet, depositAnd, publishRounds, settleBy
    } = context;

    describe('attacks we considered: custody', function () {
        it('double-settle is impossible: the status guard blocks any second payout', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 10, price: '61000' } });
            assertSuccess(await settleBy(STRANGER));
            assertReverted(await settleBy(STRANGER), 'already settled');
            assertContractBalance(h.ledger, ADDR, TICK, '0');
        });

        it('underfunded accept reverts; the maker cannot take their own bet', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            assertReverted(await depositAnd(TAKER, 'accept', '50'), 'insufficient deposit');
            h.seedBalance(MAKER, TICK, '300');
            assertReverted(await depositAnd(MAKER, 'accept'), 'cannot take their own bet');
        });
    });
};
