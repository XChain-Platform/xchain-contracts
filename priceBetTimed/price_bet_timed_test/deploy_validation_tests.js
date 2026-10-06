'use strict';

module.exports = function registerDeployValidationTests(context) {
    const {
        ADDR, MAKER, PAIR, STRIKE, TICK, STAKE, T, T0, CODE, XChainVM, E2EHarness, assert,
        assertContractState, h, deployBet
    } = context;

    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(MAKER, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: MAKER, contractAddress: 'C:BTC:2', params: params });
        }

        it('rejects a settle time in the past and an invalid side', async function () {
            const past = await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T0 - 100), '5']);
            assert.strictEqual(past.success, false, 'settleTime in the past should revert in initialize');
            const side = await deployWith([MAKER, PAIR, STRIKE, 'HIGHER', TICK, STAKE, String(T), '5']);
            assert.strictEqual(side.success, false, 'side=HIGHER should revert in initialize');
        });

        // Notation gate: maker text such as '1.5e-8' (off-grid stake, wedged
        // refund) or '1.23456789e2' (floor corrupts to 1.23456789, a theft)
        // must be rejected at deploy, because the refund floor assumes fixed notation.
        it('rejects every non-fixed-notation spelling of stake and strike', async function () {
            const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                         '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                         'Infinity', 'NaN', '1.2.3'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, v, String(T), '5'])).success, false,
                    `stake ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, v, 'OVER', TICK, STAKE, String(T), '5'])).success, false,
                    `strike ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('still accepts ordinary fixed-notation terms, trailing zeros included', async function () {
            for (const v of ['100', '0.5', '60000.00', '0.000000015', '999999999999']) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, v, String(T), '5'])).success, true,
                    `stake ${JSON.stringify(v)} must deploy`);
            }
        });

        // Integer-shape gate: a radix-less parseInt re-measures '1e2' as 1,
        // '0x10' as 16 and '7abc' as 7, so settleTime and deadlineBlocks must
        // match a strict integer shape before they are parsed.
        it('rejects integer params a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e2', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                         '+7', '', 'abc', '-', 'Infinity', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, v, '5'])).success, false,
                    `settleTime ${JSON.stringify(v)} must not deploy`);
                assert.strictEqual(
                    (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), v])).success, false,
                    `deadlineBlocks ${JSON.stringify(v)} must not deploy`);
            }
            // '1.7e9' is a real 2023 timestamp that parseInt would read as 1.
            assert.strictEqual(
                (await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '1.7e9', '5'])).success, false);
        });

        it('rejects integer params outside their range and stores accepted ones verbatim', async function () {
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), '0'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), '1000001'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, '253402300800', '5'])).success, false);
            assert.strictEqual((await deployWith([MAKER, PAIR, STRIKE, 'OVER', TICK, STAKE, String(T), '1000000'])).success, true);

            // '100' means 100 blocks in state, not the 1 a parseInt of '1e2' gave.
            await deployBet('OVER', 100);
            assertContractState(h.ledger, ADDR, 'window', '100');
            assertContractState(h.ledger, ADDR, 'settleTime', String(T));
        });
    });
};
