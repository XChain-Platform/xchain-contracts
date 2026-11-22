'use strict';

// Every payout SEND carries a memo the indexer accepts (non-empty, no pipe or
// semicolon, at most 250 UTF-16 units), so a recipient that requires a memo on
// incoming SENDs cannot make settle() or reclaim() revert.
module.exports = function registerPayoutMemoTests(ctx) {
    const { assert, assertSuccess, MAKER, TAKER, STRIKE, deployBet, depositAnd, publishRound,
        run, settle, matched, mine } = ctx;

    function sends(result) {
        return result.emittedActions.filter(function (e) { return e.action === 'SEND'; });
    }

    function assertMemoed(list) {
        for (const s of list) {
            const memo = s.params.memo;
            assert.strictEqual(typeof memo, 'string', 'every payout carries a memo');
            assert.ok(memo.length > 0 && memo.length <= 250, 'memo is non-empty and within the SEND cap');
            assert.ok(memo.indexOf('|') === -1 && memo.indexOf(';') === -1, 'memo has no delimiter');
        }
    }

    describe('payout memos', function () {
        it('the winner payout carries a memo', async function () {
            await matched('OVER');
            publishRound('61000');
            const list = sends(await settle());
            assert.strictEqual(list.length, 1);
            assertMemoed(list);
        });

        it('a maker cancel refund carries a memo', async function () {
            await deployBet('OVER');
            assertSuccess(await depositAnd(MAKER, 'fund'));
            const r = await run('cancel', MAKER);
            assertSuccess(r);
            const list = sends(r);
            assert.strictEqual(list.length, 1);
            assertMemoed(list);
        });

        it('a PUSH refunds both stakes, each leg with a memo', async function () {
            await matched('OVER');
            publishRound(STRIKE);
            const r = await settle();
            assertSuccess(r);
            const list = sends(r);
            assert.deepStrictEqual(list.map(function (s) { return s.params.destination; }), [MAKER, TAKER]);
            assertMemoed(list);
        });

        it('a VOID refunds both stakes, each leg with a memo', async function () {
            await matched('OVER', 3);
            mine(3);
            const r = await run('reclaim', TAKER);
            assertSuccess(r);
            const list = sends(r);
            assert.deepStrictEqual(list.map(function (s) { return s.params.destination; }), [MAKER, TAKER]);
            assertMemoed(list);
        });
    });
};
