'use strict';

module.exports = function registerDeployValidationTests(tests) {
    const {
        assert, XChainVM, E2EHarness, assertSuccess, assertContractState,
        CODE, SELLER, ITEM, BID
    } = tests;

    describe('deploy-time validation', function () {
        it('rejects itemTick === bidTick', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:2',
                params: [SELLER, BID, '10', BID, '50', '5']
            });
            assert.strictEqual(r.success, false, 'deploy with itemTick === bidTick should revert');
        });

        it('rejects a non-positive minBid', async function () {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await bad.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:3',
                params: [SELLER, ITEM, '10', BID, '0', '5']
            });
            assert.strictEqual(r.success, false, 'deploy with minBid=0 should revert');
        });

        // deadlineBlocks is raw deployer text. A radix-less parseInt would measure
        // '1e3' as 1 and arm a 1-block auction the seller never asked for, so the
        // constructor shape-checks it (requireIntInRange) instead.
        it('rejects a deadlineBlocks that is not a canonical integer', async function () {
            const BAD = ['1e3', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99',
                         '1_000', '+7', '', 'abc', '-', 'Infinity', 'NaN', '0',
                         '-5', '1000001'];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                bad.seedBalance(SELLER, 'XCHAIN', '1000000');
                const r = await bad.deploy({
                    code: CODE, deployer: SELLER, contractAddress: 'C:BTC:9',
                    params: [SELLER, ITEM, '10', BID, '50', BAD[i]]
                });
                assert.strictEqual(r.success, false,
                    'deploy with deadlineBlocks ' + JSON.stringify(BAD[i]) + ' should revert');
            }
        });

        it('accepts a canonical deadlineBlocks and stores it verbatim', async function () {
            const ok = new E2EHarness(XChainVM);
            ok.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await ok.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:4',
                params: [SELLER, ITEM, '10', BID, '50', '1000']
            });
            assertSuccess(r);
            assertContractState(ok.ledger, 'C:BTC:4', 'window', '1000');
        });

        // itemAmount is stored verbatim and floorToDecimals assumes fixed notation,
        // so '2.5e-2' would pass the grid check yet read as 0.025 on the ledger.
        // The notation gate must run before either.
        it('rejects an itemAmount that is not a plain fixed-notation decimal', async function () {
            const BAD = ['2.5e-2', '1e3', '0x10', '+1.5', '.5', '5.', '1_000',
                         '1.2.3', '', ' 10', 'abc', '-10'];
            for (let i = 0; i < BAD.length; i++) {
                const bad = new E2EHarness(XChainVM);
                bad.seedBalance(SELLER, 'XCHAIN', '1000000');
                const r = await bad.deploy({
                    code: CODE, deployer: SELLER, contractAddress: 'C:BTC:11',
                    params: [SELLER, ITEM, BAD[i], BID, '50', '5']
                });
                assert.strictEqual(r.success, false,
                    'deploy with itemAmount ' + JSON.stringify(BAD[i]) + ' should revert');
            }
        });

        it('accepts an off-grid but plainly spelled itemAmount and stores it verbatim', async function () {
            const ok = new E2EHarness(XChainVM);
            ok.seedBalance(SELLER, 'XCHAIN', '1000000');
            const r = await ok.deploy({
                code: CODE, deployer: SELLER, contractAddress: 'C:BTC:12',
                params: [SELLER, ITEM, '0.25', BID, '50', '5']
            });
            assertSuccess(r);
            assertContractState(ok.ledger, 'C:BTC:12', 'itemAmount', '0.25');
        });
    });
};
