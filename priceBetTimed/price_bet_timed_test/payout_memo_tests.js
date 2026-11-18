'use strict';

function sends(result) {
    return result.emittedActions.filter(function (e) { return e.action === 'SEND'; });
}

function destinations(list) {
    return list.map(function (s) { return s.params.destination; });
}

// A memo the indexer accepts: non-empty, no pipe or semicolon, at most 250
// UTF-16 units. A recipient that requires a memo on incoming SENDs cannot make
// settle() or reclaim() revert while every payout carries one.
function assertMemoed(assert, list) {
    for (const s of list) {
        const memo = s.params.memo;
        assert.strictEqual(typeof memo, 'string', 'every payout carries a memo');
        assert.ok(memo.length > 0 && memo.length <= 250, 'memo is non-empty and within the SEND cap');
        assert.ok(memo.indexOf('|') === -1 && memo.indexOf(';') === -1, 'memo has no delimiter');
    }
}

module.exports = function registerPayoutMemoTests(context) {
    const {
        ADDR, MAKER, TAKER, STRANGER, STRIKE, T, h, assert, assertSuccess,
        deployBet, depositAnd, publishRounds, settleBy
    } = context;

    async function matchedBet(window) {
        await deployBet('OVER', window);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
    }

    function runAs(method, caller) {
        return h.execute({ contractAddress: ADDR, method: method, params: [], caller: caller });
    }

    function assertBothLegs(r) {
        assertSuccess(r);
        assert.deepStrictEqual(destinations(sends(r)), [MAKER, TAKER]);
        assertMemoed(assert, sends(r));
    }

    describe('payout memos', function () {
        it('the winner payout carries a memo', async function () {
            await matchedBet();
            publishRounds({ 2: { ts: T + 10, price: '61000' } });
            const list = sends(await settleBy(STRANGER));
            assert.strictEqual(list.length, 1);
            assertMemoed(assert, list);
        });

        it('a maker cancel refund carries a memo', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            const r = await runAs('cancel', MAKER);
            assertSuccess(r);
            assert.strictEqual(sends(r).length, 1);
            assertMemoed(assert, sends(r));
        });

        it('a PUSH refunds both stakes, each leg with a memo', async function () {
            await matchedBet();
            publishRounds({ 2: { ts: T + 50, price: STRIKE } });
            assertBothLegs(await settleBy(STRANGER));
        });

        it('a VOID refunds both stakes, each leg with a memo', async function () {
            await matchedBet(3);
            publishRounds({ 2: { ts: T - 100, price: '65000' } });
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertBothLegs(await runAs('reclaim', TAKER));
        });
    });
};
