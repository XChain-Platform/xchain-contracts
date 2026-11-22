'use strict';

module.exports = function registerMintLockTests(ctx) {
    registerValidatorTest(ctx);
    registerInventoryTests(ctx);
};

function registerValidatorTest(ctx) {
    const {
        assert, ALICE, ADDR, LIQ, STABLE_MAX_SUPPLY,
        mintValidation, issueSupplyRules, deployVault
    } = ctx;

    it('refuses public MINT and supply-raising ISSUE under the emitted locks', async function () {
        const deployed = await deployVault();
        const issue = deployed.result.emittedActions.find(e => e.action === 'ISSUE').params;
        const validator = {
            util: {
                isNull: value => value === null || value === undefined || value === '',
                isValidAmountFormat: () => true,
                isCryptoAddress: () => true
            },
            indexerDb: { isActionAllowed: async () => true },
            config: { MAX_MEMO_LENGTH: 1024 }
        };
        const tokenInfo = {
            DECIMALS: Number(issue.decimals),
            LOCK_MINT: Number(issue.lockMint),
            LOCK_MINT_SUPPLY: Number(issue.lockMintSupply)
        };
        for (const caller of [ALICE, LIQ, ADDR]) {
            const mint = { data: { SOURCE: caller, AMOUNT: '1', MEMO: '' }, tokenInfo, error: null };
            await mintValidation.validateTokenRules.call(validator, mint);
            assert.strictEqual(mint.error, 'invalid: LOCK_MINT');
        }
        const reissue = {
            data: { SOURCE: ALICE, MINT_SUPPLY: '1', TRANSFER: '', TRANSFER_SUPPLY: '' },
            tokenInfo,
            error: null
        };
        issueSupplyRules.validateTransferFields.call(validator, reissue);
        assert.strictEqual(reissue.error, 'invalid: MINT_SUPPLY (locked)');
        assert.strictEqual(issue.mintSupply, STABLE_MAX_SUPPLY);
    });

    it('control: the same validator admits a public MINT when the lock fields are absent', async function () {
        const validator = {
            util: {
                isNull: value => value === null || value === undefined || value === '',
                isValidAmountFormat: () => true,
                isCryptoAddress: () => true
            },
            indexerDb: { isActionAllowed: async () => true },
            config: { MAX_MEMO_LENGTH: 1024 }
        };
        const mint = { data: { SOURCE: ALICE, AMOUNT: '1', MEMO: '' },
            tokenInfo: { DECIMALS: 8, LOCK_MINT: null, LOCK_MINT_SUPPLY: null }, error: null };
        await mintValidation.validateTokenRules.call(validator, mint);
        assert.strictEqual(mint.error, null);
    });
}

function registerInventoryTests(ctx) {
    const { assert, ALICE, ADDR, STABLE, LIQ, STABLE_MAX_SUPPLY,
        assertSuccess, assertReverted, assertContractState, deployVault, setPrice,
        depositColl, borrow, repay, liquidate } = ctx;
    it('borrow and repay cycle restores inventory without MINT or DESTROY', async function () {
        await deployVault();
        setPrice('100');
        assertSuccess(await depositColl(ALICE, '3'));
        const borrowed = await borrow(ALICE, '100');
        assertSuccess(borrowed);
        assert.strictEqual(borrowed.emittedActions.some(e => e.action === 'MINT'), false);
        const repaid = await repay(ALICE, '100');
        assertSuccess(repaid);
        assert.strictEqual(repaid.emittedActions.some(e => e.action === 'DESTROY'), false);
        assertContractState(ctx.h.ledger, ADDR, 'stableInventory', STABLE_MAX_SUPPLY);
    });

    it('refuses a borrow past the remaining stable inventory', async function () {
        await deployVault();
        setPrice('100');
        ctx.h.seedBalance(ALICE, ctx.COLL, '20000000');
        assertSuccess(await depositColl(ALICE, '20000000'));
        assertReverted(await borrow(ALICE, '1000000001'), 'stable supply exhausted');
        assertContractState(ctx.h.ledger, ADDR, 'stableInventory', STABLE_MAX_SUPPLY);
        assertSuccess(await borrow(ALICE, STABLE_MAX_SUPPLY));
        assertContractState(ctx.h.ledger, ADDR, 'stableInventory', '0');
    });

    it('liquidation returns covered stable to inventory without DESTROY', async function () {
        await deployVault();
        setPrice('100');
        assertSuccess(await depositColl(ALICE, '3'));
        assertSuccess(await borrow(ALICE, '200'));
        setPrice('80');
        ctx.h.seedBalance(LIQ, STABLE, '200');
        const result = await liquidate(LIQ, ALICE, '200');
        assertSuccess(result);
        assert.strictEqual(result.emittedActions.some(e => e.action === 'DESTROY'), false);
        assertContractState(ctx.h.ledger, ADDR, 'stableInventory', STABLE_MAX_SUPPLY);
    });
}
