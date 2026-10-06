'use strict';

function registerDeployRejections(context) {
    const {
        BID, CODE, E2EHarness, ITEM, SELLER, XChainVM, assert
    } = context;

    it('rejects itemTick === bidTick', async function () {
        const bad = new E2EHarness(XChainVM);
        bad.seedBalance(SELLER, 'XCHAIN', '1000000');
        const r = await bad.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:2',
            params: [SELLER, BID, '10', BID, '1000', '100', '10']
        });
        assert.strictEqual(r.success, false, 'deploy with itemTick === bidTick should revert');
    });

    it('rejects startPrice <= endPrice', async function () {
        const bad = new E2EHarness(XChainVM);
        bad.seedBalance(SELLER, 'XCHAIN', '1000000');
        const r = await bad.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:3',
            params: [SELLER, ITEM, '10', BID, '100', '100', '10']
        });
        assert.strictEqual(r.success, false, 'deploy with startPrice === endPrice should revert');
    });

    it('rejects a non-positive durationBlocks', async function () {
        const bad = new E2EHarness(XChainVM);
        bad.seedBalance(SELLER, 'XCHAIN', '1000000');
        const r = await bad.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:4',
            params: [SELLER, ITEM, '10', BID, '1000', '100', '0']
        });
        assert.strictEqual(r.success, false, 'deploy with durationBlocks=0 should revert');
    });

    // durationBlocks is raw deployer text. A radix-less parseInt would measure
    // '1e3' as 1 and arm a 1-block decay the seller never asked for, so the
    // constructor shape-checks it (requireIntInRange) instead.
    it('rejects a durationBlocks that is not a canonical integer', async function () {
        const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99',
                     '1_000', '+7', '', 'abc', '-', 'Infinity', 'NaN',
                     '-5', '1000001'];
        for (let i = 0; i < BAD.length; i++) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:9',
                params: [SELLER, ITEM, '10', BID, '1000', '100', BAD[i]]
            });
            assert.strictEqual(r.success, false,
                'deploy with durationBlocks ' + JSON.stringify(BAD[i]) + ' should revert');
        }
    });
}

function registerPriceNotationCases(context) {
    const {
        BID, CODE, E2EHarness, ITEM, SELLER, XChainVM, assert,
        assertContractState, assertSuccess, buy
    } = context;

    it('accepts a canonical durationBlocks and stores it verbatim', async function () {
        const ok = new E2EHarness(XChainVM);
        ok.seedBalance(SELLER, 'XCHAIN', '1000000');
        const r = await ok.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:5',
            params: [SELLER, ITEM, '10', BID, '1000', '100', '1000']
        });
        assertSuccess(r);
        assertContractState(ok.ledger, 'C:BTC:5', 'duration', '1000');
    });

    // startPrice/endPrice are raw deployer text and xchain.math accepts every
    // spelling mathjs parses, so the magnitude checks are no filter. endPrice
    // reaches floorToDecimals unchanged once the decay window has elapsed, and
    // that helper CORRUPTS an exotic spelling rather than no-opping on it
    // ('1.23456789e2' -> '1.23456789', a 1% payout). Gate the notation at the door.
    it('rejects a startPrice or endPrice that is not a plain fixed-notation decimal', async function () {
        const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                     '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                     'Infinity', 'NaN', '1.2.3', '10abc', ' 10'];
        for (let i = 0; i < BAD.length; i++) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:10',
                params: [SELLER, ITEM, '10', BID, '1000', BAD[i], '10']
            });
            assert.strictEqual(r.success, false,
                'deploy with endPrice ' + JSON.stringify(BAD[i]) + ' should revert');
        }

        const badStart = new E2EHarness(XChainVM);
        badStart.seedBalance(SELLER, 'XCHAIN', '1000000');
        const rs = await badStart.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:11',
            params: [SELLER, ITEM, '10', BID, '1e4', '100', '10']
        });
        assert.strictEqual(rs.success, false, "deploy with startPrice '1e4' should revert");
    });

    // The gate is notation-only, NOT a grid check: an off-grid but legitimately
    // spelled price still deploys and is stored verbatim, because bidTick's
    // decimals are unreadable at deploy time and buy() floors onto them instead.
    it('accepts an off-grid but plainly spelled endPrice and stores it verbatim', async function () {
        const ok = new E2EHarness(XChainVM);
        ok.seedBalance(SELLER, 'XCHAIN', '1000000');
        const r = await ok.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:12',
            params: [SELLER, ITEM, '10', BID, '1000', '100.123456789', '10']
        });
        assertSuccess(r);
        assertContractState(ok.ledger, 'C:BTC:12', 'endPrice', '100.123456789');
    });
}

function registerItemAmountCases(context) {
    const {
        BID, CODE, E2EHarness, ITEM, SELLER, XChainVM, assert,
        assertContractState, assertSuccess, buy
    } = context;

    // itemAmount reaches floorToDecimals at fund() and is emitted verbatim at
    // buy()/cancel(), so it needs the notation gate the price terms have: on
    // '2.5e-2' the floor is a no-op and the grid check blesses 0.025.
    it('rejects an itemAmount that is not a plain fixed-notation decimal', async function () {
        const BAD = ['2.5e-2', '1e3', '0x10', '+1.5', '.5', '5.', '1_000',
                     '1.2.3', '', ' 10', 'abc', '-10'];
        for (let i = 0; i < BAD.length; i++) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:13',
                params: [SELLER, ITEM, BAD[i], BID, '1000', '100', '10']
            });
            assert.strictEqual(r.success, false,
                'deploy with itemAmount ' + JSON.stringify(BAD[i]) + ' should revert');
        }
    });

    it('accepts an off-grid but plainly spelled itemAmount and stores it verbatim', async function () {
        const ok = new E2EHarness(XChainVM);
        ok.seedBalance(SELLER, 'XCHAIN', '1000000');
        const r = await ok.deploy({
            code: CODE, deployer: SELLER, contractAddress: 'C:BTC:14',
            params: [SELLER, ITEM, '0.25', BID, '1000', '100', '10']
        });
        assertSuccess(r);
        assertContractState(ok.ledger, 'C:BTC:14', 'itemAmount', '0.25');
    });
}

function registerDeployValidationCases(context) {
    describe('deploy-time validation', function () {
        registerDeployRejections(context);
        registerPriceNotationCases(context);
        registerItemAmountCases(context);
    });
}

module.exports = { registerDeployValidationCases };
