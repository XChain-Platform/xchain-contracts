'use strict';

// A non-ok callback (expired, error, failed) has no readable response row;
// it must clear pending, not revert.
function registerUnwedgeTests(context) {
    const { ADDR, HOLDER, assertSuccess, assertReverted, assertEmittedActions, deployBridge, getHarness } = context;
    describe('non-ok callbacks never wedge requestClaim', function () {
        for (const status of ['expired', 'error', 'failed']) {
            it('a ' + status + ' callback with no readable response clears pending and unwedges requestClaim', async function () {
                await deployBridge();
                const h = getHarness();
                const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
                const requestId = JSON.parse(req.returnValue);
                // No seeded row: the live attestation view hides non-ok outcomes.
                const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', status, '', HOLDER], caller: HOLDER });
                assertSuccess(cb, status + ' is a no-op, not a revert');
                assertEmittedActions(cb, []);
                const retry = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
                assertSuccess(retry, 'requestClaim must be callable again');
            });
        }

        it('a callback for a mismatched request id still reverts', async function () {
            await deployBridge();
            const h = getHarness();
            await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'onClaim', params: ['bogus', 'http_get', 'expired', '', HOLDER], caller: HOLDER }),
                'not the outstanding claim request');
        });

        it('an ok callback with no readable response still reverts', async function () {
            await deployBridge();
            const h = getHarness();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER }),
                'no response yet');
        });
    });
}

// Builds the helper that deploys, opens a claim for HOLDER, seeds the sends
// response and runs the onClaim callback with the same status the indexer
// would pass. The helper returns the harness, the request id and the result.
function makeRequestAndCallback(context) {
    const { ADDR, HOLDER, deployBridge, getHarness, seedSendsResponse } = context;
    return async function requestAndCallback(body, status) {
        const cbStatus = status || 'ok';
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);

        seedSendsResponse(requestId, body, cbStatus);
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', cbStatus, '', HOLDER], caller: HOLDER });
        return { h, requestId, cb };
    };
}

// The live attestation view never exposes a non-ok row, so these run with no
// readable response, and the null guard proves the seeding helper served none.
function registerNonOkAttestationTests(context, requestAndCallback) {
    const { ADDR, HOLDER, assert, assertSuccess, assertEmittedActions } = context;
    describe('non-ok attestation outcomes are no-ops with no readable row', function () {
        for (const status of ['failed', 'expired']) {
            it('a ' + status + ' attestation is also a no-op with no readable row', async function () {
                const { h, requestId, cb } = await requestAndCallback('', status);
                assert.strictEqual(h.ledger.buildAttestationAccessor().getResponse(requestId), null,
                    'a ' + status + ' response must not be readable, as in the live attestation view');
                assertSuccess(cb, status + ' is a no-op, not a revert');
                assertEmittedActions(cb, []);

                const retry = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
                assertSuccess(retry, 'requestClaim should be callable again after a ' + status + ' callback cleared pending');
            });
        }
    });
}

module.exports = function registerNoBurnFailureTests(context) {
    const {
        ADDR, HOLDER, OTHER, assertSuccess, assertReverted, assertEmittedActions,
        deployBridge, getHarness, sendsPayload
    } = context;
    const requestAndCallback = makeRequestAndCallback(context);

    registerUnwedgeTests(context);
    registerNonOkAttestationTests(context, requestAndCallback);

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
