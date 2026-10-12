'use strict';

// The price leg is floored onto bidTick's grid; the ITEM leg was never checked at
// all. buy() and cancel() emit itemAmount verbatim and the indexer re-quantises
// every emitted amount onto its tick's grid at write time, so an off-grid item
// silently normalises - to ZERO on a 0-decimal tick, which is a VALID SEND that
// moves nothing. The buyer would pay in full, receive nothing, and the deposit
// would sit in a SOLD auction out of cancel()'s reach, so the gate belongs at
// fund(), before the auction arms.
async function deployOffGridItem(context, itemAmount) {
    const { ADDR, BID, CODE, E2EHarness, ITEM, SELLER, XChainVM } = context;
    context.h = new E2EHarness(XChainVM);
    context.h.seedBalance(SELLER, 'XCHAIN', '1000000');
    context.h.seedBalance(SELLER, ITEM, '10');
    context.h.ledger.setTokenDecimals(BID, 0);
    context.h.ledger.setTokenDecimals(ITEM, 0);
    return context.h.deploy({
        code: CODE, deployer: SELLER, contractAddress: ADDR,
        params: [SELLER, ITEM, itemAmount, BID, '1000', '100', '10']
    });
}

function registerSettlementAttacks(context) {
    const {
        ADDR, BID, ITEM, SELLER, assert, assertContractBalance, assertContractState,
        assertEmittedActions, assertReverted, assertSuccess, buy, deployAuction, depositAndFund
    } = context;

    it('fund() rejects an underfunded item deposit', async function () {
        await deployAuction(10);
        context.h.deposit(SELLER, ADDR, ITEM, '5');
        assertReverted(await context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
            'insufficient item deposit');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
    });

    it('only the seller can fund or cancel', async function () {
        await deployAuction(10);
        context.h.seedBalance('stranger', ITEM, '10');
        context.h.deposit('stranger', ADDR, ITEM, '10');
        assertReverted(await context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: 'stranger' }),
            'only the seller');
        await depositAndFund();
        assertReverted(await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
            'only the seller');
    });

    it('an underpaying buy() refunds the deposit in the same call and sells nothing', async function () {
        await deployAuction(10);
        await depositAndFund();
        const r = await buy('alice', '500');
        assertSuccess(r);
        assert.strictEqual(JSON.parse(r.returnValue), 'underpaid');
        assertEmittedActions(r, [{ action: 'SEND', params: { destination: 'alice', tick: BID, quantity: '500' } }]);
        assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
        assertContractBalance(context.h.ledger, ADDR, BID, '0');
    });

    it('a second buy() after a sale is rejected: single-shot settlement', async function () {
        await deployAuction(10);
        await depositAndFund();
        assertSuccess(await buy('alice', '1000'));
        assertReverted(await buy('bob', '1000'), 'not active');
        assertContractBalance(context.h.ledger, ADDR, ITEM, '0'); // no double-payout
    });

    it('cancel() is rejected once the item is sold', async function () {
        await deployAuction(10);
        await depositAndFund();
        await buy('alice', '1000');
        assertReverted(await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
            'not cancellable');
    });

    it('buying before funding reverts', async function () {
        await deployAuction(10);
        assertReverted(await buy('alice', '1000'), 'not active');
    });
}

function registerOffGridFundAttack(context) {
    const {
        ADDR, ITEM, SELLER, assertBalance, assertContractBalance,
        assertContractState, assertEmittedActions, assertReverted,
        assertSuccess, buy
    } = context;

    it('fund() rejects an itemAmount that is off the item tick grid', async function () {
        assertSuccess(await deployOffGridItem(context, '0.25'));
        context.h.deposit(SELLER, ADDR, ITEM, '10');
        assertReverted(
            await context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
            'not representable at itemTick decimals');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
        // Never armed, so no buy.
        assertReverted(await buy('alice', '1000'), 'not active');
        // The rejecting fund() did NOT roll back the deposit, so cancel() from
        // the pre-funded state is the seller's recovery path. It returns the
        // HELD balance, not the off-grid itemAmount the ledger would re-quantise
        // to nothing.
        const c = await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
        assertSuccess(c);
        assertEmittedActions(c, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '10' } }]);
        assertBalance(context.h.ledger, SELLER, ITEM, '10');
        assertContractBalance(context.h.ledger, ADDR, ITEM, '0');
        assertContractState(context.h.ledger, ADDR, 'status', 'CANCELLED');
    });
}

function registerCancelRecoveryAttacks(context) {
    const {
        ADDR, ITEM, SELLER, assertBalance, assertContractState,
        assertEmittedActions, assertReverted, assertSuccess, deployAuction,
        depositAndFund
    } = context;

    it('cancel() returns a short deposit after fund() rejected it', async function () {
        await deployAuction(10);
        context.h.deposit(SELLER, ADDR, ITEM, '5');
        assertReverted(
            await context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
            'insufficient item deposit');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
        const c = await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER });
        assertSuccess(c);
        assertEmittedActions(c, [{ action: 'SEND', params: { destination: SELLER, tick: ITEM, quantity: '5' } }]);
        assertBalance(context.h.ledger, SELLER, ITEM, '10');
        assertContractState(context.h.ledger, ADDR, 'status', 'CANCELLED');
    });

    it('a stranger cannot cancel() a pre-funded auction', async function () {
        await deployAuction(10);
        context.h.deposit(SELLER, ADDR, ITEM, '10');
        assertReverted(
            await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: 'stranger' }),
            'only the seller');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
    });

    it('cancel() on a contract holding nothing reverts rather than latching CANCELLED', async function () {
        await deployAuction(10);
        assertReverted(
            await context.h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: SELLER }),
            'nothing to reclaim');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
        assertSuccess(await depositAndFund());
        assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
    });
}

function registerOnGridControls(context) {
    const {
        ADDR, ITEM, SELLER, assertBalance, assertContractState, assertReverted,
        assertSuccess, buy, deployAuction, depositAndFund
    } = context;

    it('an off-grid itemAmount above one unit is rejected too, not rounded up', async function () {
        assertSuccess(await deployOffGridItem(context, '2.5'));
        context.h.deposit(SELLER, ADDR, ITEM, '10');
        assertReverted(
            await context.h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: SELLER }),
            'not representable at itemTick decimals');
        assertContractState(context.h.ledger, ADDR, 'status', 'INIT');
    });

    // The control the gate needs: a gate that reverted every fund() would look
    // identical to a gate that caught the defect.
    it('an on-grid itemAmount still funds, sells and delivers the exact quantity', async function () {
        await deployAuction(10);
        assertSuccess(await depositAndFund());
        assertSuccess(await buy('alice', '1000'));
        assertBalance(context.h.ledger, 'alice', ITEM, '10');
    });
}

function registerSubGridPriceAttack(context) {
    const {
        ADDR, BID, CODE, E2EHarness, ITEM, SELLER, XChainVM, assertBalance,
        assertContractBalance, assertContractState, assertReverted, buy,
        deployAuction, depositAndFund
    } = context;

    // A sub-grid endPrice deploys clean (the constructor gates notation and
    // magnitude, never the grid), so the decayed asking price can floor to '0'
    // on bidTick. Without the post-floor positivity guard, gte(held, '0')
    // admits a caller who deposited nothing, the seller is paid an AMOUNT=0
    // no-op and the auction latches SOLD out of cancel()'s reach.
    it('a sub-grid asking price reverts instead of selling the item for nothing', async function () {
        context.h = new E2EHarness(XChainVM);
        context.h.seedBalance(SELLER, 'XCHAIN', '1000000');
        context.h.seedBalance(SELLER, ITEM, '10');
        context.h.ledger.setTokenDecimals(BID, 0);
        context.h.ledger.setTokenDecimals(ITEM, 0);   // see deployAuction: fund() reads the item grid
        await context.h.deploy({
            code: CODE, deployer: SELLER, contractAddress: ADDR,
            params: [SELLER, ITEM, '10', BID, '1000', '0.5', '10']
        });
        await depositAndFund();
        for (let i = 0; i < 50; i++) context.h.mineBlock(); // past duration: price is endPrice 0.5, which floors to '0'

        assertReverted(
            await context.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: 'mallory' }),
            'below one unit of the bid tick');
        assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');
        assertContractBalance(context.h.ledger, ADDR, ITEM, '10');
        assertBalance(context.h.ledger, 'mallory', ITEM, '0');
    });
}

// Before buy() refunded a short payment it reverted, the BATCH kept the deposit, and
// once the falling price reached it any caller could buy() with nothing deposited,
// taking the item plus the difference while the seller was paid from the stray.
function registerStrandedUnderpaymentAttack(context) {
    const {
        ADDR, BID, ITEM, SELLER, assert, assertBalance, assertContractBalance,
        assertContractState, assertEmittedActions, assertSuccess, buy,
        deployAuction, depositAndFund
    } = context;

    it('an underpayment is not left for a zero-deposit caller once the price falls to it', async function () {
        await deployAuction(10);
        await depositAndFund();
        assertSuccess(await buy('alice', '500'));
        for (let i = 0; i < 50; i++) context.h.mineBlock(); // past duration: price is pinned at 100

        const m = await context.h.execute({ contractAddress: ADDR, method: 'buy', params: [], caller: 'mallory' });
        assertSuccess(m);
        assert.strictEqual(JSON.parse(m.returnValue), 'underpaid');
        assertEmittedActions(m, []);
        assertBalance(context.h.ledger, 'alice', BID, '500');
        assertBalance(context.h.ledger, 'mallory', ITEM, '0');
        assertBalance(context.h.ledger, 'mallory', BID, '0');
        assertContractBalance(context.h.ledger, ADDR, ITEM, '10');
        assertContractState(context.h.ledger, ADDR, 'status', 'ACTIVE');

        assertSuccess(await buy('bob', '100'));
        assertBalance(context.h.ledger, 'bob', ITEM, '10');
        assertBalance(context.h.ledger, SELLER, BID, '100');
        assertContractBalance(context.h.ledger, ADDR, BID, '0');
    });
}

function registerAttackCases(context) {
    describe('attacks we considered', function () {
        registerSettlementAttacks(context);
        registerStrandedUnderpaymentAttack(context);
        registerOffGridFundAttack(context);
        registerCancelRecoveryAttacks(context);
        registerOnGridControls(context);
        registerSubGridPriceAttack(context);
    });
}

module.exports = { registerAttackCases };
