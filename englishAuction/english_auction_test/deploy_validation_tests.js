'use strict';

// Deploy the template on a fresh harness and return { h, r }.
async function deployFresh(tests, contractAddress, params) {
    const { XChainVM, E2EHarness, CODE, SELLER } = tests;
    const h = new E2EHarness(XChainVM);
    h.seedBalance(SELLER, 'XCHAIN', '1000000');
    const r = await h.deploy({ code: CODE, deployer: SELLER, contractAddress, params });
    return { h, r };
}

function registerTickAndBidTests(tests) {
    const { assert, SELLER, ITEM, BID } = tests;

    it('rejects itemTick === bidTick', async function () {
        const { r } = await deployFresh(tests, 'C:BTC:2', [SELLER, BID, '10', BID, '50', '5']);
        assert.strictEqual(r.success, false, 'deploy with itemTick === bidTick should revert');
    });

    it('rejects a non-positive minBid', async function () {
        const { r } = await deployFresh(tests, 'C:BTC:3', [SELLER, ITEM, '10', BID, '0', '5']);
        assert.strictEqual(r.success, false, 'deploy with minBid=0 should revert');
    });

    // minBid is stored verbatim and echoed by info(), and every spelling here
    // passes the > 0 magnitude check, so only the notation gate can refuse it.
    it('rejects a minBid that is not a plain fixed-notation decimal', async function () {
        const BAD = ['1e3', '0x10', '+1.5', '.5', '5.', '1_000', 'Infinity'];
        const accepted = [];
        for (let i = 0; i < BAD.length; i++) {
            const { r } = await deployFresh(tests, 'C:BTC:13', [SELLER, ITEM, '10', BID, BAD[i], '5']);
            if (r.success || !String(r.error).includes('minBid')) accepted.push(BAD[i] + ' -> ' + (r.success ? 'deployed' : r.error));
        }
        assert.deepStrictEqual(accepted, [], 'minBid spellings not refused by the minBid gate');
    });
}

function registerDeadlineTests(tests) {
    const { assert, assertSuccess, assertContractState, SELLER, ITEM, BID } = tests;

    // deadlineBlocks is raw deployer text. A radix-less parseInt would measure
    // '1e3' as 1 and arm a 1-block auction the seller never asked for, so the
    // constructor shape-checks it (requireIntInRange) instead.
    it('rejects a deadlineBlocks that is not a canonical integer', async function () {
        const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99',
                     '1_000', '+7', '', 'abc', '-', 'Infinity', 'NaN', '0',
                     '-5', '1000001'];
        for (let i = 0; i < BAD.length; i++) {
            const { r } = await deployFresh(tests, 'C:BTC:9',
                [SELLER, ITEM, '10', BID, '50', BAD[i]]);
            assert.strictEqual(r.success, false,
                'deploy with deadlineBlocks ' + JSON.stringify(BAD[i]) + ' should revert');
        }
    });

    it('accepts a canonical deadlineBlocks and stores it verbatim', async function () {
        const { h, r } = await deployFresh(tests, 'C:BTC:4', [SELLER, ITEM, '10', BID, '50', '1000']);
        assertSuccess(r);
        assertContractState(h.ledger, 'C:BTC:4', 'window', '1000');
    });
}

function registerItemAmountTests(tests) {
    const { assert, assertSuccess, assertContractState, SELLER, ITEM, BID } = tests;

    // itemAmount is stored verbatim and floorToDecimals assumes fixed notation,
    // so '2.5e-2' would pass the grid check yet read as 0.025 on the ledger.
    // The notation gate must run before either.
    it('rejects an itemAmount that is not a plain fixed-notation decimal', async function () {
        const BAD = ['2.5e-2', '1e3', '0x10', '+1.5', '.5', '5.', '1_000',
                     '1.2.3', '', ' 10', 'abc', '-10'];
        for (let i = 0; i < BAD.length; i++) {
            const { r } = await deployFresh(tests, 'C:BTC:11',
                [SELLER, ITEM, BAD[i], BID, '50', '5']);
            assert.strictEqual(r.success, false,
                'deploy with itemAmount ' + JSON.stringify(BAD[i]) + ' should revert');
        }
    });

    it('accepts an off-grid but plainly spelled itemAmount and stores it verbatim', async function () {
        const { h, r } = await deployFresh(tests, 'C:BTC:12', [SELLER, ITEM, '0.25', BID, '50', '5']);
        assertSuccess(r);
        assertContractState(h.ledger, 'C:BTC:12', 'itemAmount', '0.25');
    });
}

module.exports = function registerDeployValidationTests(tests) {
    describe('deploy-time validation', function () {
        registerTickAndBidTests(tests);
        registerDeadlineTests(tests);
        registerItemAmountTests(tests);
    });
};
