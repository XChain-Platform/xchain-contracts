'use strict';

module.exports = function registerNoBurnFailureTests(context) {
    const {
        ADDR, HOLDER, OTHER, assertSuccess, assertReverted, assertEmittedActions,
        deployBridge, getHarness, seedSendsResponse, sendsPayload
    } = context;

    // Deploys, opens a claim for HOLDER, seeds the sends response and runs the
    // onClaim callback. Returns the harness and the callback result.
    async function requestAndCallback(body, status) {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);

        seedSendsResponse(requestId, body, status);
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        return { h, cb };
    }

    describe('no burns / failure: no-op, not fatal', function () {
        it('no matching burns is a no-op: pending clears, nothing minted', async function () {
            const { h, cb } = await requestAndCallback(sendsPayload([]));
            assertSuccess(cb, 'no burns is a no-op, not a revert');
            assertEmittedActions(cb, []);

            const retry = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(retry, 'requestClaim should be callable again after a no-burns check cleared pending');
        });

        it('a malformed / non-JSON body is treated as no burns found, not a crash', async function () {
            const { cb } = await requestAndCallback('not json at all');
            assertSuccess(cb, 'malformed body should not crash the callback');
            assertEmittedActions(cb, []);
        });

        it('a failed attestation is also a no-op', async function () {
            const { cb } = await requestAndCallback('', 'failed');
            assertSuccess(cb);
            assertEmittedActions(cb, []);
        });

        it('requestClaim rejects a second check while one is already pending for that address', async function () {
            await deployBridge();
            const h = getHarness();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }),
                'already pending');
        });

        it('a pending check for one address does not block another address', async function () {
            await deployBridge();
            const h = getHarness();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: OTHER }));
        });
    });
};
