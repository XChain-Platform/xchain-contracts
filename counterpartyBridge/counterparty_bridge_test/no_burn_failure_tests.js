'use strict';

module.exports = function registerNoBurnFailureTests(context) {
    const {
        ADDR, HOLDER, OTHER, assertSuccess, assertReverted, assertEmittedActions,
        deployBridge, getHarness, seedSendsResponse, sendsPayload
    } = context;

    describe('no burns / failure: no-op, not fatal', function () {
        it('no matching burns is a no-op: pending clears, nothing minted', async function () {
            await deployBridge();
            const h = getHarness();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedSendsResponse(requestId, sendsPayload([]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'no burns is a no-op, not a revert');
            assertEmittedActions(cb, []);

            const retry = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(retry, 'requestClaim should be callable again after a no-burns check cleared pending');
        });

        it('a malformed / non-JSON body is treated as no burns found, not a crash', async function () {
            await deployBridge();
            const h = getHarness();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedSendsResponse(requestId, 'not json at all');
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'malformed body should not crash the callback');
            assertEmittedActions(cb, []);
        });

        it('a failed attestation is also a no-op', async function () {
            await deployBridge();
            const h = getHarness();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedSendsResponse(requestId, '', 'failed');
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
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
