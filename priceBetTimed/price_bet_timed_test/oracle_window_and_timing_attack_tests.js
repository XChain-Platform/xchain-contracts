'use strict';

module.exports = function registerOracleWindowAndTimingAttackTests(context) {
    describe('attacks we considered: timing and oracle window', function () {
        registerTimingAttacks(context);
        registerStaleTipAttacks(context);
        registerEvictedRoundAttacks(context);
        registerCursorAttacks(context);
    });
};

function registerTimingAttacks(context) {
    const {
        ADDR, MAKER, TAKER, STRANGER, TICK, T, assert, assertSuccess, assertReverted, assertBalance,
        assertContractState, h, deployBet, depositAnd, publishRounds, settleBy, returned
    } = context;

    it('accept after the settle time reverts (betting window closed)', async function () {
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        h.mineBlock(); h.mineBlock(); h.mineBlock(); // ts 1700001800 >= T
        assertReverted(await depositAnd(TAKER, 'accept'), 'betting window closed');
    });

    it('reclaim() cannot dodge a lost bet once a qualifying round exists', async function () {
        await deployBet('OVER', 3);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
        h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
        publishRounds({ 2: { ts: T + 10, price: '59000' } }); // maker (OVER) lost
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
            'settle() instead');
        assertSuccess(await settleBy(TAKER));
        assertBalance(h.ledger, TAKER, TICK, '200');
    });

    // Round N+1 may carry an EARLIER timestamp than round N (Bitcoin only
    // needs a header above the median of the previous eleven).
    // Reading the tip alone would skip a round that already decided the bet.
    it('a BACKWARD tip timestamp cannot hide the deciding round from settle()', async function () {
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
        publishRounds({
            3: { ts: T + 100, price: '61000' },  // decides: OVER maker wins
            4: { ts: T - 100, price: '59000' }   // tip, timestamp moves BACKWARD
        });
        const r = await settleBy(STRANGER);
        assertSuccess(r);
        assert.strictEqual(returned(r), 'SETTLED');
        assertContractState(h.ledger, ADDR, 'settledRound', '3');
        assertBalance(h.ledger, MAKER, TICK, '200');
    });

    it('a BACKWARD tip timestamp cannot void a decided bet through reclaim()', async function () {
        await deployBet('OVER', 3);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
        h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
        publishRounds({
            3: { ts: T + 10,  price: '59000' },  // decides: OVER maker LOST
            4: { ts: T - 100, price: '59000' }   // tip, timestamp moves BACKWARD
        });
        // The losing maker reads a pre-T tip and reaches for the liveness hatch.
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
            'settle() instead');
        assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
        assertSuccess(await settleBy(TAKER));
        assertBalance(h.ledger, TAKER, TICK, '200');
    });
}

function registerStaleTipAttacks(context) {
    const {
        ADDR, MAKER, TAKER, TICK, T, assertSuccess, assertReverted, assertBalance, assertContractState,
        h, deployBet, depositAnd, publishRoundsWithTip, settleBy
    } = context;

    it('STALE ORACLE, pre-flag-day node: the loser voids a bet history already decided', async function () {
        // Documents the exposure the stale-round visibility flag day closes:
        // the indexer drops a stale tip from getPrice() but keeps it in
        // getPriceAtRound(), so getPrice() denies the deciding round exists.
        await deployBet('OVER', 3);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
        h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
        // Round 2 decides against the OVER maker, but the tip is suppressed.
        publishRoundsWithTip({ 2: { ts: T + 10, price: '59000' } }, null);

        // The winner cannot settle: settle() needs the tip before it walks history.
        assertReverted(await settleBy(TAKER), 'no oracle data yet');
        // ...and the LOSER's void is the only executable transition.
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }));
        assertContractState(h.ledger, ADDR, 'status', 'VOID');
        assertBalance(h.ledger, TAKER, TICK, '100');   // the winner got their stake back, not the pot
    });

    it('STALE ORACLE, at/after the flag day: the withheld tip blocks the void and settle() pays the winner', async function () {
        // After the activation height the stale tip is kept with its price
        // withheld, so its round identity and timestamp suffice for the void guard.
        await deployBet('OVER', 3);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
        h.mineBlock(); h.mineBlock(); h.mineBlock(); // past the deadline
        publishRoundsWithTip({ 2: { ts: T + 10, price: '59000' } },
            { price: null, roundNumber: 2, timestamp: T + 10, stale: true });

        assertReverted(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: MAKER }),
            'settle() instead');
        // settle() reads the deciding price from immutable history.
        assertSuccess(await settleBy(TAKER));
        assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
        assertContractState(h.ledger, ADDR, 'settledRound', '2');
        assertBalance(h.ledger, TAKER, TICK, '200');
    });

    it('a withheld tip BEFORE settleTime still voids: the liveness hatch survives the flag day', async function () {
        // The guard compares the withheld tip's timestamp, which is below
        // settleTime here, so a genuine oracle stall must not wedge the bet.
        await deployBet('OVER', 3);
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');
        h.mineBlock(); h.mineBlock(); h.mineBlock();
        publishRoundsWithTip({ 2: { ts: T - 100, price: '65000' } },
            { price: null, roundNumber: 2, timestamp: T - 100, stale: true });

        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'reclaim', params: [], caller: TAKER }));
        assertContractState(h.ledger, ADDR, 'status', 'VOID');
        assertBalance(h.ledger, MAKER, TICK, '100');
        assertBalance(h.ledger, TAKER, TICK, '100');
    });
}

function registerEvictedRoundAttacks(context) {
    const {
        ADDR, MAKER, TAKER, STRANGER, TICK, PAIR, T, T0, assertSuccess, assertReverted, assertBalance,
        assertContractBalance, assertContractState, h, deployBet, depositAnd, publishRounds,
        publishRoundsWithTip, settleBy
    } = context;

    it('a scan read without round metadata fails loud instead of being skipped as a gap', async function () {
        // Shape drift: getPriceAtRound hands back a bare price string, so the
        // read has timestamp NaN and `NaN >= T` would step over the deciding
        // round like a gap; the scan must refuse it as latestRound() does.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');

        // Round 2 decides (ts >= T) but arrives bare; the latest-round signal
        // stays well formed so the scan is actually entered.
        h.ledger.seedOracle(PAIR, { price: '61000', roundNumber: 2, timestamp: T + 10 }, 0, { 2: '61000' });

        assertReverted(await settleBy(STRANGER), 'lacks round metadata');
        assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
        assertContractBalance(h.ledger, ADDR, TICK, '200');
    });

    it('an EVICTED round in the scan span fails loud instead of letting a later round decide', async function () {
        // A round below the preload floor comes back priceless with timestamp 0,
        // so `0 >= T` is false and a LATER round would decide, making the
        // outcome depend on when settle() was first called.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');

        // Round 5 is all the payload still holds and it pays the OVER maker.
        publishRounds({ 5: { ts: T + 700, price: '61000' } });
        h.ledger.seedOracleRoundFloor(5);

        assertReverted(await settleBy(STRANGER), 'outside the retrievable oracle window');
        assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
        assertContractBalance(h.ledger, ADDR, TICK, '200');
        assertBalance(h.ledger, MAKER, TICK, '0');
    });

    it('a fully evicted scan span reverts instead of reporting SCANNING forever', async function () {
        // With cursor..top entirely below the floor the scan must revert, not
        // persist the cursor and answer SCANNING while reclaim() also refuses.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        await depositAnd(TAKER, 'accept');

        h.ledger.seedOracle(PAIR, { price: '61000', roundNumber: 5, timestamp: T + 700 }, 0, {});
        h.ledger.seedOracleRoundFloor(6);

        assertReverted(await settleBy(STRANGER), 'outside the retrievable oracle window');
        assertContractState(h.ledger, ADDR, 'status', 'MATCHED');
        assertContractBalance(h.ledger, ADDR, TICK, '200');
    });

    it('an absent round INSIDE the window is still a genuine gap and still settles', async function () {
        // With the cursor at or above the floor a missing round is a skipped
        // round, so the scan keeps stepping over it.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        publishRounds({ 2: { ts: T - 1200, price: '59000' } });   // tip at match
        await depositAnd(TAKER, 'accept');                        // pins cursor = 2

        publishRounds({
            2: { ts: T - 1200, price: '59000' },
            3: { ts: T - 900,  price: '59000' },
            5: { ts: T + 100,  price: '61000' }   // decides: OVER maker wins
        });
        h.ledger.seedOracleRoundFloor(2);   // round 1 is evicted, below the cursor
        // Round 4 is absent and at/above the floor: a real gap, stepped over.

        assertSuccess(await settleBy(STRANGER));
        assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
        assertBalance(h.ledger, MAKER, TICK, '200');
    });

    it('accept() refuses a pair with no readable tip: the birth-wedge cannot be minted', async function () {
        // Without the guard the cursor falls back to round 1, already evicted on
        // a mature host, so settle() reverts forever and both stakes lock.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        h.ledger.oraclePrices[PAIR].current = null;   // pair has no readable tip
        h.ledger.seedOracleRoundFloor(1200);          // mature host: round 1 is long evicted

        assertReverted(await depositAnd(TAKER, 'accept'), 'no oracle data for pair yet');
        assertContractState(h.ledger, ADDR, 'status', 'OPEN');
        assertContractState(h.ledger, ADDR, 'cursor', undefined);

        // Nothing is stranded: the bet never matched, so cancel() still drains it.
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }));
        assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        assertContractBalance(h.ledger, ADDR, TICK, '0');
    });

    it('accept() refuses a tip round that is itself already evicted', async function () {
        // The null-tip check cannot see this wedge: a pair that stops publishing
        // keeps a readable getPrice() tip whose round is below the global floor.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        // Tip readable through getPrice, its round absent from the loaded history.
        h.ledger.seedOracle(PAIR, { price: '59000', roundNumber: 7, timestamp: T0 }, 0, {});
        h.ledger.seedOracleRoundFloor(1200);

        assertReverted(await depositAnd(TAKER, 'accept'),
            'tip round is outside the retrievable oracle window');
        assertContractState(h.ledger, ADDR, 'status', 'OPEN');
        assertContractState(h.ledger, ADDR, 'cursor', undefined);

        // Nothing is stranded: the bet never matched, so cancel() still drains it.
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MAKER }));
        assertContractState(h.ledger, ADDR, 'status', 'CANCELLED');
        assertContractBalance(h.ledger, ADDR, TICK, '0');
    });

    it('a withheld-price tip below the floor is refused at accept() too', async function () {
        // The post-flag-day stale shape keeps a non-null tip object, so the
        // null-tip guard is silent; accept() must check the round is readable.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        publishRoundsWithTip({ 9: { ts: T0, price: '59000' } },
            { price: null, roundNumber: 9, timestamp: T0, stale: true });
        h.ledger.oraclePrices[PAIR].rounds = {};   // round 9 evicted from the payload
        h.ledger.seedOracleRoundFloor(1200);

        assertReverted(await depositAnd(TAKER, 'accept'),
            'tip round is outside the retrievable oracle window');
        assertContractState(h.ledger, ADDR, 'status', 'OPEN');
    });
}

function registerCursorAttacks(context) {
    const {
        ADDR, MAKER, TAKER, STRANGER, TICK, T, assert, assertSuccess, assertBalance, assertContractState,
        h, deployBet, depositAnd, publishRounds, settleBy, returned
    } = context;

    it('PENDING advances the cursor, so window slide cannot wedge a watched bet', async function () {
        // The cursor only matters inside the node's preload window, so a
        // pre-expiry call must be able to move it. The floor is raised directly
        // because the wedge is a floor-above-cursor relation, not a round count.
        await deployBet('OVER');
        await depositAnd(MAKER, 'fund');
        publishRounds({ 2: { ts: T - 1200, price: '59000' } });
        await depositAnd(TAKER, 'accept');                        // pins cursor = 2
        assertContractState(h.ledger, ADDR, 'cursor', '2');

        publishRounds({
            2: { ts: T - 1200, price: '59000' },
            3: { ts: T - 900,  price: '59000' },
            4: { ts: T - 600,  price: '59500' }   // tip, still pre-T
        });
        const pending = await settleBy(STRANGER);
        assertSuccess(pending);
        assert.strictEqual(returned(pending), 'PENDING');
        // Every round from the cursor to the tip was read and missed T, so the
        // cursor clears the tip: 5, not 4.
        assertContractState(h.ledger, ADDR, 'cursor', '5');

        // A second PENDING call on an unmoved tip must not walk the cursor back.
        assertSuccess(await settleBy(STRANGER));
        assertContractState(h.ledger, ADDR, 'cursor', '5');

        // Now the window slides past the acceptance round and the deciding round lands.
        publishRounds({
            4: { ts: T - 600, price: '59500' },
            5: { ts: T + 100, price: '61000' }    // decides: OVER maker wins
        });
        h.ledger.seedOracleRoundFloor(4);

        assertSuccess(await settleBy(STRANGER));
        assertContractState(h.ledger, ADDR, 'status', 'SETTLED');
        assertContractState(h.ledger, ADDR, 'settledRound', '5');
        assertBalance(h.ledger, MAKER, TICK, '200');
    });
}
