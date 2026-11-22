// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// amm_test/exact_custody.js: real-VM tests for the exact custody guards in amm.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

// The VM's mathjs compare reads values within max(1e-12 relative, 1e-15) as equal, so
// each case below sits inside that band and passes only through an exact guard.
module.exports = function registerExactCustodyTests(ctx) {
    const {
        A, B, LP, ADDR, LP1, LP2, T1, assert, assertSuccess, assertContractState,
        bn, deploy, getHarness, addLiq, swap, emitted, reserves
    } = ctx;

    async function deploy18() {
        await deploy();
        getHarness().ledger.setTokenDecimals(A, 18);
        getHarness().ledger.setTokenDecimals(B, 18);
    }

    it('swap credits an 18-decimal input below 1e-15 instead of stranding it', async function () {
        await deploy18();
        assertSuccess(await addLiq(LP1, '1', '1000000'));
        const r = await swap(T1, A, '0.0000000000000001', '0');
        assertSuccess(r);
        assert.ok(bn(emitted(r, 'SEND', B).params.quantity).gt(0), 'positive output');
        assertContractState(getHarness().ledger, ADDR, 'reserveA', '1.0000000000000001');
    });

    it('swap pays an 18-decimal output below 1e-15', async function () {
        await deploy18();
        assertSuccess(await addLiq(LP1, '1000000', '1'));
        const r = await swap(T1, A, '0.000000001', '0');
        assertSuccess(r);
        const out = emitted(r, 'SEND', B).params.quantity;
        // Decimal gt/lt are exact; math.larger/smaller would read this dust as equal to the bound.
        assert.ok(bn(out).gt(0) && bn(out).lt('0.000000000000001'), 'dust output ' + out);
    });

    it('swap pays an output within 1e-12 of the reserve and leaves the reserve positive', async function () {
        await deploy();
        assertSuccess(await addLiq(LP1, '0.00001', '1000000'));
        const r = await swap(T1, A, '100000000', '0');
        assertSuccess(r);
        const left = bn(reserves().b);
        assert.ok(left.gt(0) && left.lt('0.000001'), 'reserveB left ' + reserves().b);
    });

    it('removeLiquidity pays an 18-decimal payout below 1e-15', async function () {
        await deploy18();
        assertSuccess(await addLiq(LP1, '0.0000000001', '1000000'));
        getHarness().deposit(LP1, ADDR, LP, '0.00000001');
        const r = await getHarness().execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 });
        assertSuccess(r);
        assert.strictEqual(emitted(r, 'SEND', A).params.quantity, '0.0000000000000001');
    });

    it('addLiquidity mints for an 18-decimal deposit below 1e-15', async function () {
        await deploy18();
        assertSuccess(await addLiq(LP1, '0.0000000001', '1000000'));
        const r = await addLiq(LP2, '0.0000000000000001', '1');
        assertSuccess(r);
        assert.strictEqual(emitted(r, 'SEND', LP).params.quantity, '0.00000001');
    });
};
