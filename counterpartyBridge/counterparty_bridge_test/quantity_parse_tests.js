'use strict';

module.exports = function registerQuantityParseTests(context) {
    const {
        ADDR, HOLDER, XC_TICK, assert, assertSuccess, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    describe('non-fixed-notation feed quantities are rejected at the parse seam', function () {
        async function claimWith(quantity, txHash) {
            const h = getHarness();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(req);
            const requestId = JSON.parse(req.returnValue);
            seedSendsResponse(requestId, sendsPayload([{ txHash: txHash, quantity: quantity }]));
            return h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        }

        it('a corrupting exponential quantity mints nothing instead of 1% of the burn', async function () {
            await deployBridge();
            const h = getHarness();
            const txHash = nextTxHash();
            const cb = await claimWith('1.23456789e2', txHash);
            assertSuccess(cb, 'a malformed row must not wedge the address');
            assertEmittedActions(cb, []);
            assertContractState(h.ledger, ADDR, 'totalClaimed', '0');
            assert.ok(!('claimedTotal:' + HOLDER in h.ledger.getContractState(ADDR)),
                'nothing may be credited from an unusable quantity');
            assert.ok(!('pending:' + HOLDER in h.ledger.getContractState(ADDR)),
                'pending must clear so the address can claim again');
            assert.ok(!('burned:' + txHash in h.ledger.getContractState(ADDR)),
                'a dropped row must not mark its burn as credited');

            const good = await claimWith('123.456789', txHash);
            assertSuccess(good);
            assertEmittedActions(good, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '123.456789', destination: HOLDER } }]);
            assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '123.456789');
        });

        it('drops only the unusable rows and still credits the well-formed ones in the same page', async function () {
            await deployBridge();
            const h = getHarness();
            const badTx = nextTxHash(), goodTx = nextTxHash();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedSendsResponse(requestId, sendsPayload([
                { txHash: badTx, quantity: '1.5e-8' },
                { txHash: goodTx, quantity: '10.25' }
            ]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb);
            assertEmittedActions(cb, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '10.25', destination: HOLDER } }]);
            assertContractState(h.ledger, ADDR, 'burned:' + goodTx, true);
            assert.ok(!('burned:' + badTx in h.ledger.getContractState(ADDR)),
                'the dropped row must not be marked credited');
            assertContractState(h.ledger, ADDR, 'totalClaimed', '10.25');
        });

        it('every non-fixed-notation spelling is dropped, plain decimals are kept', async function () {
            const BAD = ['1.5e-8', '0.15e-7', '1.5E-8', '1e-8', '1.23456789e2',
                         '0x10', '0b101', '0o17', '1_000', '+1.5', '.5', '5.',
                         'Infinity', 'NaN', '1.2.3', '-5', ' 5', ''];
            for (const v of BAD) {
                await deployBridge();
                const h = getHarness();
                const cb = await claimWith(v, nextTxHash());
                assertSuccess(cb, `quantity ${JSON.stringify(v)} must not revert`);
                assertEmittedActions(cb, []);
                assertContractState(h.ledger, ADDR, 'totalClaimed', '0');
            }
            for (const v of ['42', '42.5', '0.00000001', '1000000']) {
                await deployBridge();
                const cb = await claimWith(v, nextTxHash());
                assertSuccess(cb, `quantity ${JSON.stringify(v)} must be credited`);
                assertEmittedActions(cb, [{ action: 'MINT', params: { tick: XC_TICK, quantity: v, destination: HOLDER } }]);
            }
        });
    });
};
