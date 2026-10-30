'use strict';

module.exports = function registerMintLockTests(ctx) {
    const {
        T1, LP2, LP1, ADDR, A, LP, assert, mintValidation, issueSupplyRules,
        deploy, addLiq, swap, getHarness
    } = ctx;

    it('refuses unauthorized public MINT and any later supply-raising ISSUE under the emitted lock flags', async function () {
        const deployed = await deploy();
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

        for (const caller of [T1, LP2, LP1, ADDR]) {
            const mintContext = {
                data: { SOURCE: caller, AMOUNT: '1', MEMO: '' }, tokenInfo, error: null
            };
            await mintValidation.validateTokenRules.call(validator, mintContext);
            assert.strictEqual(mintContext.error, 'invalid: LOCK_MINT', 'MINT refused for ' + caller);
        }

        const issueContext = {
            data: { SOURCE: LP1, MINT_SUPPLY: '1', TRANSFER: '', TRANSFER_SUPPLY: '' },
            tokenInfo,
            error: null
        };
        issueSupplyRules.validateTransferFields.call(validator, issueContext);
        assert.strictEqual(issueContext.error, 'invalid: MINT_SUPPLY (locked)', 'supply-raising re-ISSUE refused');

        let r = await addLiq(LP1, '1000', '1000');
        assert.strictEqual(r.emittedActions.some(e => e.action === 'MINT'), false);
        getHarness().deposit(LP1, ADDR, LP, '10');
        r = await getHarness().execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 });
        assert.strictEqual(r.emittedActions.some(e => e.action === 'MINT'), false);
        r = await swap(T1, A, '10', '0');
        assert.strictEqual(r.emittedActions.some(e => e.action === 'MINT'), false);
    });
};
