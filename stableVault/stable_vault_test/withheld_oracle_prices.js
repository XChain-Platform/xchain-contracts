'use strict';

// freshPrice() refuses every oracle shape that carries no usable price, while
// deposit() and repay() stay open: de-risking a vault is never blocked.

// Open a vault with live debt so every price-reading method has work to refuse.
async function openIndebtedVault(ctx) {
    const { ALICE, deployVault, setPrice, depositColl, borrow, assertSuccess } = ctx;
    await deployVault();
    setPrice('100');
    assertSuccess(await depositColl(ALICE, '3'));
    assertSuccess(await borrow(ALICE, '100'));
}

// Assert borrow, withdraw and liquidate all revert with `reason`.
async function assertPriceReadersRevert(ctx, reason) {
    const { ALICE, LIQ, STABLE, borrow, withdraw, liquidate, assertReverted } = ctx;
    assertReverted(await borrow(ALICE, '10'), reason);
    assertReverted(await withdraw(ALICE, '1'), reason);
    ctx.h.seedBalance(LIQ, STABLE, '100');
    assertReverted(await liquidate(LIQ, ALICE, '100'), reason);
}

// Assert the owner can still add collateral and repay the whole debt.
async function assertDeRiskingOpen(ctx) {
    const { ALICE, ADDR, depositColl, repay, assertSuccess, assertContractState } = ctx;
    assertSuccess(await depositColl(ALICE, '1'));
    assertSuccess(await repay(ALICE, '100'));
    assertContractState(ctx.h.ledger, ADDR, 'v:' + ALICE + ':debt', '0');
}

module.exports = function registerWithheldOraclePriceTests(ctx) {
    const { ALICE, deployVault, depositColl, borrow, assertReverted } = ctx;

    describe('withheld and missing oracle prices', function () {
        it('a recent withheld-price tip blocks price readers but never deposit/repay', async function () {
            await openIndebtedVault(ctx);
            // The indexer's post-gate stale shape: round identity kept, price withheld.
            // Passed as an object because seedOracle stringifies a bare null.
            ctx.h.ledger.seedOracle(ctx.PAIR,
                { price: null, roundNumber: 2, timestamp: ctx.h.ledger.blockTimestamp, stale: true }, 0, {});
            await assertPriceReadersRevert(ctx, 'no oracle price for pair');
            await assertDeRiskingOpen(ctx);
        });

        it('an old withheld-price tip trips the round-age check first', async function () {
            await openIndebtedVault(ctx);
            ctx.h.ledger.seedOracle(ctx.PAIR,
                { price: null, roundNumber: 2, timestamp: ctx.h.ledger.blockTimestamp - 50, stale: true }, 0, {});
            await assertPriceReadersRevert(ctx, 'oracle price is stale');
            await assertDeRiskingOpen(ctx);
        });

        it('a pair with no published price blocks price readers but never deposit/repay', async function () {
            await openIndebtedVault(ctx);
            // Drop the vault pair but keep the fleet snapshot fresh through another pair.
            delete ctx.h.ledger.oraclePrices[ctx.PAIR];
            ctx.h.ledger.seedOracle('SILVER/USD',
                { price: '25', roundNumber: 9, timestamp: ctx.h.ledger.blockTimestamp }, 0, {});
            await assertPriceReadersRevert(ctx, 'no oracle price for pair');
            await assertDeRiskingOpen(ctx);
        });

        it('a zero oracle price is refused', async function () {
            await deployVault();
            ctx.h.ledger.seedOracle(ctx.PAIR,
                { price: '0', roundNumber: 1, timestamp: ctx.h.ledger.blockTimestamp }, 0, {});
            await depositColl(ALICE, '3');
            assertReverted(await borrow(ALICE, '10'), 'oracle price must be positive');
        });
    });
};
