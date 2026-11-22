'use strict';

// Deploy-time parameter validation.

function makeBad(ctx) {
    const { OWNER, CODE, XChainVM, E2EHarness } = ctx;
    return async function bad(params) {
        const b = new E2EHarness(XChainVM);
        b.seedBalance(OWNER, 'XCHAIN', '1000000');
        return b.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9', params });
    };
}

function registerShapeChecks(ctx, bad) {
    const { OWNER, PAY, SALE, RATE, SOFT, HARD, assert } = ctx;
    it('rejects payTick == saleTick', async function () {
        assert.strictEqual((await bad([OWNER, PAY, PAY, RATE, SOFT, HARD, '50', '8'])).success, false);
    });
    it('rejects hardCap < softCap', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, '200', '100', '50', '8'])).success, false);
    });
    it('rejects rate <= 0', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, '0', SOFT, HARD, '50', '8'])).success, false);
    });
    it('rejects a non-finite rate', async function () {
        for (const rate of ['Infinity', '-Infinity', 'NaN', '1e3']) {
            const res = await bad([OWNER, PAY, SALE, rate, SOFT, HARD, '50', '8']);
            assert.strictEqual(res.success, false, 'rate ' + rate + ' deployed');
            assert(String(res.error).includes('rate must be a plain decimal'), 'got: ' + res.error);
        }
    });
    // Caps get the same notation gate as rate: math.gt and the exact compare accept
    // these spellings, and the caps are stored and echoed by info() verbatim.
    it('rejects a softCap or hardCap that is not a plain decimal', async function () {
        for (const v of ['1e3', '0x10', '1_000', '+100', '100.', '.5e3', ' 100', '1.2.3']) {
            const soft = await bad([OWNER, PAY, SALE, RATE, v, '100000', '50', '8']);
            assert.strictEqual(soft.success, false, 'softCap ' + JSON.stringify(v) + ' deployed');
            assert(String(soft.error).includes('softCap'), 'got: ' + soft.error);
            const hard = await bad([OWNER, PAY, SALE, RATE, '1', v, '50', '8']);
            assert.strictEqual(hard.success, false, 'hardCap ' + JSON.stringify(v) + ' deployed');
            assert(String(hard.error).includes('hardCap'), 'got: ' + hard.error);
        }
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, '100.5', '200.25', '50', '8'])).success, true,
            'plain fractional caps still deploy');
    });
}

function registerDecimalsChecks(ctx, bad) {
    const { OWNER, PAY, SALE, RATE, SOFT, HARD, CODE, XChainVM, E2EHarness, assert } = ctx;
    // saleDecimals validation (finding 2705): it feeds both the permanent
    // emit.issue grid and claim()'s floor; a malformed value must fail the
    // deploy instead of desyncing the two.
    it('rejects a non-numeric saleDecimals', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', 'eight'])).success, false);
    });
    it('rejects a fractional saleDecimals', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '8.5'])).success, false);
    });
    it('rejects a negative saleDecimals', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '-1'])).success, false);
    });
    it('rejects saleDecimals above the ISSUE maximum of 18', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '19'])).success, false);
    });
    it('accepts the boundary values 0 and 18', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '0'])).success, true);
        const b2 = new E2EHarness(XChainVM);
        b2.seedBalance(OWNER, 'XCHAIN', '1000000');
        const r = await b2.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
            params: [OWNER, PAY, SALE, RATE, SOFT, HARD, '50', '18'] });
        assert.strictEqual(r.success, true);
    });
    it('an omitted saleDecimals still defaults to 8', async function () {
        const b3 = new E2EHarness(XChainVM);
        b3.seedBalance(OWNER, 'XCHAIN', '1000000');
        const r = await b3.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
            params: [OWNER, PAY, SALE, RATE, SOFT, HARD, '50'] });
        assert.strictEqual(r.success, true);
        const issue = r.result.emittedActions.find(e => e.action === 'ISSUE');
        assert.strictEqual(issue.params.decimals, '8');
    });

}

function registerDurationChecks(ctx, bad) {
    const { OWNER, PAY, SALE, RATE, SOFT, HARD, CODE, XChainVM, E2EHarness, assert } = ctx;
    // durationBlocks gets the same integer-SHAPE gate saleDecimals gets, and
    // for the same reason: it is raw deployer text burned into the permanent
    // `deadline` key, and a radix-less parseInt re-measures it ('1e3' -> 1,
    // '0x10' -> 16, '5.99' -> 5, ' 5' -> 5, '+5' -> 5, '5abc' -> 5). A sale
    // the DEPLOY action advertises as 1000 blocks would open for one: buy()
    // rejects every later contribution and finalize() latches FAILED for want
    // of the soft cap.
    it('rejects a durationBlocks a radix-less parseInt would silently re-measure', async function () {
        const BAD = ['1e3', '0x10', '5.99', ' 5', '+5', '5abc', '1_000',
                     '', 'abc', 'Infinity', 'NaN', '0', '-1'];
        for (const v of BAD) {
            assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, v, '8'])).success,
                false, `durationBlocks ${JSON.stringify(v)} must not deploy`);
        }
    });

    it('accepts the durationBlocks window bounds and stores the value verbatim', async function () {
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '1', '8'])).success, true);
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '1000000', '8'])).success, true);
        assert.strictEqual((await bad([OWNER, PAY, SALE, RATE, SOFT, HARD, '1000001', '8'])).success, false);

        // '1000' means 1000 blocks in the deadline, not the 1 a parseInt of
        // '1e3' gave, counted from the height the harness deploys at.
        const b4 = new E2EHarness(XChainVM);
        b4.seedBalance(OWNER, 'XCHAIN', '1000000');
        const r = await b4.deploy({ code: CODE, deployer: OWNER, contractAddress: 'C:BTC:9',
            params: [OWNER, PAY, SALE, RATE, SOFT, HARD, '1000', '8'] });
        assert.strictEqual(r.success, true);
        assert.strictEqual(b4.ledger.getContractStateKey('C:BTC:9', 'deadline'),
            String(b4.ledger.getContract('C:BTC:9').blockIndex + 1000));
    });
}

function registerDeployValidation(ctx) {
    describe('deploy-time validation', function () {
        const bad = makeBad(ctx);
        registerShapeChecks(ctx, bad);
        registerDecimalsChecks(ctx, bad);
        registerDurationChecks(ctx, bad);
    });
}

module.exports = registerDeployValidation;
