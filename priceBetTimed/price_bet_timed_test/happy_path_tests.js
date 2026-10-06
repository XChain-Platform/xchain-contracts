'use strict';

module.exports = function registerHappyPathTests(context) {
    const {
        ADDR, MAKER, TAKER, STRANGER, TICK, PAIR, STRIKE, T, CODE, XChainVM, E2EHarness, h, setHarness,
        assert, assertSuccess, assertReverted, assertBalance, assertContractBalance, assertContractState,
        deployBet, seedTipRound, depositAnd, publishRounds, settleBy, returned
    } = context;

    describe('happy paths', function () {
        it('the FIRST round at/after settleTime decides: gaps skipped, later rounds ignored', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');

            // Rounds 3 and 5 are pre-deadline noise, 4 and 6 are gaps, 7 decides,
            // and 8 is later and BELOW the strike so it must not matter.
            publishRounds({
                3: { ts: T - 900, price: '59000' },
                5: { ts: T - 300, price: '59500' },
                7: { ts: T + 100, price: '61000' },
                8: { ts: T + 700, price: '50000' }
            });

            const r = await settleBy(STRANGER);
            assertSuccess(r);
            assert.strictEqual(returned(r), 'SETTLED');
            assertBalance(h.ledger, MAKER, TICK, '200');       // OVER maker wins on round 7
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
            assertContractState(h.ledger, ADDR, 'settledRound', '7');
            assertContractState(h.ledger, ADDR, 'winner', MAKER);
        });

        it('UNDER maker wins when the deciding round is below the strike', async function () {
            await deployBet('UNDER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 50, price: '59999.99' } });
            assertSuccess(await settleBy(STRANGER));
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('deciding round exactly at the strike: push, both stakes returned', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T + 50, price: STRIKE } });
            const r = await settleBy(STRANGER);
            assertSuccess(r);
            assert.strictEqual(returned(r), 'PUSH');
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'PUSH');
        });

        it('no qualifying round yet: settle() is a valid no-op returning PENDING', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 3: { ts: T - 100, price: '65000' } }); // latest still before T
            const r = await settleBy(STRANGER);
            assertSuccess(r);
            assert.strictEqual(returned(r), 'PENDING');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED'); // untouched
            assertContractBalance(h.ledger, ADDR, TICK, '200');
        });

        it('long pre-deadline backlog is paged: SCANNING persists the cursor, next call settles', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept'); // no oracle data yet -> cursor = 1

            // 250 noise rounds before T, the qualifying one at 251; the scan cap
            // is 200 reads per call, so one settle() cannot reach it.
            const spec = {};
            for (let n = 1; n <= 250; n++) spec[n] = { ts: T - 1000 + n, price: '59000' };
            spec[251] = { ts: T + 60, price: '61000' };
            publishRounds(spec);

            const first = await settleBy(STRANGER);
            assertSuccess(first);
            assert.strictEqual(returned(first), 'SCANNING');
            assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
            assertContractState(h.ledger, ADDR, 'cursor', '201'); // 1 + 200 reads

            const second = await settleBy(STRANGER);
            assertSuccess(second);
            assert.strictEqual(returned(second), 'SETTLED');
            assertContractState(h.ledger, ADDR, 'settledRound', '251');
            assertBalance(h.ledger, MAKER, TICK, '200');
        });

        it('maker cancels an unmatched bet and recovers their stake', async function () {
            await deployBet('OVER');
            await depositAnd(MAKER, 'fund');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }));
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        });

        it('oracle never reaches settleTime: either party voids after the deadline', async function () {
            await deployBet('OVER', 3);
            await depositAnd(MAKER, 'fund');
            await depositAnd(TAKER, 'accept');
            publishRounds({ 2: { ts: T - 100, price: '65000' } }); // stuck before T

            assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }),
                'deadline not reached');
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));
            assertBalance(h.ledger, MAKER, TICK, '100');
            assertBalance(h.ledger, TAKER, TICK, '100');
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
        });

        it('half-ulp off-grid stake still voids: both refund legs land on the tick grid', async function () {
            // Flooring the maker refund leg keeps both legs on the tick grid, so
            // the ledger's write-time re-round is a no-op and the residue rides
            // the taker leg; a raw half-unit stake once wedged PUSH and VOID.
            const ODD = '0.000000015';
            setHarness(new E2EHarness(XChainVM));
            h.seedBalance(MAKER, 'XCHAIN', '1000000');
            h.seedBalance(MAKER, TICK, '1');
            h.seedBalance(TAKER, TICK, '1');
            h.ledger.setTokenDecimals(TICK, 8);
            await h.deploy({
                code: CODE, deployer: MAKER, contractAddress: ADDR,
                params: [MAKER, PAIR, STRIKE, 'OVER', TICK, ODD, String(T), '3']
            });
            seedTipRound();
            assertSuccess(await depositAnd(MAKER, 'fund', '0.00000002'));
            assertSuccess(await depositAnd(TAKER, 'accept', '0.00000002'));
            publishRounds({ 2: { ts: T - 100, price: '65000' } }); // stuck before T

            h.mineBlock(); h.mineBlock(); h.mineBlock();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));

            // Legs sum to exactly what was held: 0.00000001 + 0.00000003.
            assertBalance(h.ledger, MAKER, TICK, '0.99999999');
            assertBalance(h.ledger, TAKER, TICK, '1.00000001');
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertContractState(h.ledger, ADDR, 'status', 'VOID');
        });
    });
};
