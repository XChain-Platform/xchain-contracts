'use strict';

// Sale lifecycle: success, failure, unsold-inventory burn and attack cases.

function registerSuccessfulSale(ctx, kit) {
    const { OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, CODE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const { deploy, buy, call, close } = kit;

    describe('successful sale', function () {
        it('buyers fund past the soft cap, finalize, claim tokens, owner withdraws', async function () {
            assertSuccess(await deploy());
            assertSuccess(await buy(B1, '60'));
            assertSuccess(await buy(B2, '60')); // raised 120 >= soft 100
            close();
            assertSuccess(await call('finalize', B1));

            // Buyer claims sale tokens: 60 * 10 = 600 sent to B1.
            const c = await call('claim', B1);
            assertSuccess(c);
            assertEmittedActions(c, [{ action: 'SEND', params: { tick: SALE, quantity: '600', destination: B1 } }]);
            assertBalance(kit.h.ledger, B1, SALE, '600');
            assertReverted(await call('claim', B1), 'nothing to claim'); // no double claim

            // Owner withdraws the proceeds (120 PAY).
            const w = await call('withdraw', OWNER);
            assertSuccess(w);
            assertEmittedActions(w, [{ action: 'SEND', params: { destination: OWNER, tick: PAY, quantity: '120' } }]);
            assertBalance(kit.h.ledger, OWNER, PAY, '620'); // started 500 + 120 proceeds
            assertReverted(await call('withdraw', OWNER), 'already withdrawn');
        });
    });
}

function registerFailedSale(ctx, kit) {
    const { OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, CODE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const { deploy, buy, call, close } = kit;

    describe('failed sale', function () {
        it('under the soft cap, buyers refund in full; no claim, no withdraw', async function () {
            await deploy();
            await buy(B1, '50'); // raised 50 < soft 100
            close();
            assertSuccess(await call('finalize', B1)); // FAILED

            assertReverted(await call('claim', B1), 'sale not successful');
            assertReverted(await call('withdraw', OWNER), 'sale not successful');

            const r = await call('refund', B1);
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: B1, tick: PAY, quantity: '50' } }]);
            assertBalance(kit.h.ledger, B1, PAY, '500'); // 500 - 50 deposit + 50 refund
            assertReverted(await call('refund', B1), 'nothing to refund'); // no double refund
        });
    });
}

function registerBurnTests(ctx, kit) {
    const { OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, CODE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const { deploy, buy, call, close } = kit;

    describe('burning unsold inventory', function () {
        it('burns only unallocated inventory on success and preserves outstanding claims', async function () {
            assertSuccess(await deploy());
            assertSuccess(await buy(B1, '60'));
            assertSuccess(await buy(B2, '60'));
            close();
            assertSuccess(await call('finalize', B1));

            assertSuccess(await call('claim', B1));
            const burned = await call('burnUnsold', STRANGER);
            assertSuccess(burned);
            assertEmittedActions(burned, [
                { action: 'DESTROY', params: { tick: SALE, quantity: '800' } }
            ]);
            assertContractBalance(kit.h.ledger, ADDR, SALE, '600');

            assertSuccess(await call('claim', B2));
            assertBalance(kit.h.ledger, B2, SALE, '600');
            assertContractBalance(kit.h.ledger, ADDR, SALE, '0');
            assertReverted(await call('burnUnsold', OWNER), 'unsold inventory already burned');
        });

        it('burns the entire sale-token supply after a failed sale without blocking refunds', async function () {
            assertSuccess(await deploy());
            assertSuccess(await buy(B1, '50'));
            close();
            assertSuccess(await call('finalize', B1));

            const burned = await call('burnUnsold', OWNER);
            assertSuccess(burned);
            assertEmittedActions(burned, [
                { action: 'DESTROY', params: { tick: SALE, quantity: '2000' } }
            ]);
            assertContractBalance(kit.h.ledger, ADDR, SALE, '0');
            assertSuccess(await call('refund', B1));
            assertBalance(kit.h.ledger, B1, PAY, '500');
        });

        registerBurnEdgeCases(ctx, kit);
    });
}

function registerBurnEdgeCases(ctx, kit) {
    const { OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, CODE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const { deploy, buy, call, close } = kit;

    it('burns grid-rounding inventory that a remaining-payment calculation would miss', async function () {
        assertSuccess(await deploy({ rate: '0.3', soft: '1', hard: '10', decimals: '0' }));
        assertSuccess(await buy(B1, '4'));
        assertSuccess(await buy(B2, '4'));
        close();
        assertSuccess(await call('finalize', B1));

        const burned = await call('burnUnsold', OWNER);
        assertSuccess(burned);
        assertEmittedActions(burned, [
            { action: 'DESTROY', params: { tick: SALE, quantity: '1' } }
        ]);
        assertContractBalance(kit.h.ledger, ADDR, SALE, '2');
        assertSuccess(await call('claim', B1));
        assertSuccess(await call('claim', B2));
        assertContractBalance(kit.h.ledger, ADDR, SALE, '0');
    });

    it('rejects burning before finalization', async function () {
        assertSuccess(await deploy());
        assertReverted(await call('burnUnsold', OWNER), 'sale not finalized');
    });

    it('completes without a destroy emission when the successful sale allocated everything', async function () {
        assertSuccess(await deploy());
        assertSuccess(await buy(B1, '200'));
        assertSuccess(await call('finalize', B1));

        const burned = await call('burnUnsold', OWNER);
        assertSuccess(burned);
        assertEmittedActions(burned, []);
        assert.strictEqual(JSON.parse(burned.returnValue), '0');
    });
}

function registerAttackTests(ctx, kit) {
    const { OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, CODE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const { deploy, buy, call, close } = kit;

    describe('attacks we considered', function () {
        it('locks public minting and pre-mints the sale supply into custody', async function () {
            const deployed = await deploy();
            assertSuccess(deployed);
            const issues = deployed.result.emittedActions.filter(e => e.action === 'ISSUE');
            assert.strictEqual(issues.length, 1);
            assert.strictEqual(issues[0].params.maxSupply, '2000');
            assert.strictEqual(issues[0].params.maxMint, '2000');
            assert.strictEqual(issues[0].params.mintSupply, '2000');
            assert.strictEqual(issues[0].params.lockMint, '1');
            assert.strictEqual(issues[0].params.lockMintSupply, '1');
            assertContractBalance(kit.h.ledger, ADDR, SALE, '2000');
            assert.strictEqual(CODE.indexOf('emit.mint'), -1);
        });

        it('buy() with no deposit reverts', async function () {
            await deploy();
            assertReverted(await call('buy', B1), 'no payment received');
        });

        it('buying past the deadline reverts', async function () {
            await deploy();
            close();
            assertReverted(await buy(B1, '50'), 'sale closed');
        });

        it('a contribution beyond the hard cap is rejected', async function () {
            await deploy();
            assertSuccess(await buy(B1, '200')); // exactly the hard cap
            assertReverted(await buy(B2, '1'), 'hard cap exceeded');
        });

        it('finalize before the deadline (below cap) reverts', async function () {
            await deploy();
            await buy(B1, '60');
            assertReverted(await call('finalize', B1), 'sale still open');
        });

        it('claim before finalize reverts', async function () {
            await deploy();
            await buy(B1, '120');
            assertReverted(await call('claim', B1), 'sale not successful');
        });

        registerLateAttackTests(ctx, kit);
    });
}

function registerLateAttackTests(ctx, kit) {
    const { OWNER, B1, B2, STRANGER, ADDR, PAY, SALE, CODE, assert, assertSuccess, assertReverted,
            assertEmittedActions, assertBalance, assertContractBalance } = ctx;
    const { deploy, buy, call, close } = kit;

    it('only the owner can withdraw', async function () {
        await deploy();
        await buy(B1, '120');
        close();
        await call('finalize', B1);
        assertReverted(await call('withdraw', STRANGER), 'only the owner');
    });

    it('hard cap reached allows early finalize before the deadline', async function () {
        await deploy();
        await buy(B1, '200'); // hits hard cap
        assertSuccess(await call('finalize', B1)); // early finalize OK (at cap)
    });
}

function registerSaleFlow(ctx, kit) {
    registerSuccessfulSale(ctx, kit);
    registerFailedSale(ctx, kit);
    registerBurnTests(ctx, kit);
    registerAttackTests(ctx, kit);
}

module.exports = registerSaleFlow;
