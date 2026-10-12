'use strict';

module.exports = function registerHappyPathTests(context) {
    describe('happy path: claim sends the bridged equivalent from custody', function () {
        registerSingleClaimMinting(context);
        registerMultiBurnClaims(context);
        registerIncrementalClaims(context);
    });
};

function registerSingleClaimMinting(context) {
    const {
        ADDR, HOLDER, OTHER, XC_TICK, MAX_SUPPLY, assert, assertSuccess, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    it('requestClaim -> onClaim with a matching burn pays the claiming address from custody', async function () {
        await deployBridge();
        const h = getHarness();

        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        assertSuccess(req);
        assertEmittedActions(req, [{ action: 'ATTEST', params: {
            providerId: 'http_get', callbackMethod: 'onClaim'
        } }]);
        const requestId = JSON.parse(req.returnValue);
        assertContractState(h.ledger, ADDR, 'pending:' + HOLDER, requestId);

        const txHash = nextTxHash();
        seedSendsResponse(requestId, sendsPayload([{ txHash: txHash, quantity: '42.5' }]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'relayer' });
        assertSuccess(cb);
        assertEmittedActions(cb, [{ action: 'SEND', params: { destination: HOLDER, tick: XC_TICK, quantity: '42.5' } }]);
        assertContractState(h.ledger, ADDR, 'burned:' + txHash, true);
        assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '42.5');
        assertContractState(h.ledger, ADDR, 'totalClaimed', '42.5');
        assert.ok(!('pending:' + HOLDER in h.ledger.getContractState(ADDR)), 'pending cleared after settlement');
        assert.strictEqual(h.ledger.getBalance(HOLDER, XC_TICK), '42.5', 'the claimant receives the burned amount');
        assert.strictEqual(h.ledger.getContractBalance(ADDR, XC_TICK), String(Number(MAX_SUPPLY) - 42.5),
            'custody falls by exactly the claimed amount');
    });

    it('anyone can relay the callback - the attestation itself is the authorization, not the caller', async function () {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);
        seedSendsResponse(requestId, sendsPayload([{ txHash: nextTxHash(), quantity: '10' }]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'stranger' });
        assertSuccess(cb, 'a stranger can relay a settled callback');
    });
}

function registerMultiBurnClaims(context) {
    const {
        ADDR, HOLDER, OTHER, XC_TICK, assert, assertSuccess, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    it('sums multiple burn transactions from the same address in one claim', async function () {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);
        const tx1 = nextTxHash(), tx2 = nextTxHash();
        seedSendsResponse(requestId, sendsPayload([
            { txHash: tx1, quantity: '5' },
            { txHash: tx2, quantity: '2.5' }
        ]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        assertSuccess(cb);
        assertEmittedActions(cb, [{ action: 'SEND', params: { destination: HOLDER, tick: XC_TICK, quantity: '7.5' } }]);
        assertContractState(h.ledger, ADDR, 'burned:' + tx1, true);
        assertContractState(h.ledger, ADDR, 'burned:' + tx2, true);
    });

    it('ignores burns from other sources, other assets, and other statuses in the shared burn-address feed', async function () {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);
        const mine = nextTxHash();
        seedSendsResponse(requestId, sendsPayload([
            { txHash: nextTxHash(), quantity: '999', source: OTHER },
            { txHash: nextTxHash(), quantity: '999', asset: 'SOMEOTHERASSET' },
            { txHash: nextTxHash(), quantity: '999', status: 'invalid' },
            { txHash: mine, quantity: '3' }
        ]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        assertSuccess(cb);
        assertEmittedActions(cb, [{ action: 'SEND', params: { destination: HOLDER, tick: XC_TICK, quantity: '3' } }]);
    });
}

function registerIncrementalClaims(context) {
    const {
        ADDR, HOLDER, XC_TICK, assertSuccess, assertEmittedActions, assertContractState,
        deployBridge, getHarness, seedSendsResponse, sendsPayload, nextTxHash
    } = context;

    it('a later requestClaim only mints the burns that were not already credited', async function () {
        await deployBridge();
        const h = getHarness();
        const req1 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId1 = JSON.parse(req1.returnValue);
        const tx1 = nextTxHash();
        seedSendsResponse(requestId1, sendsPayload([{ txHash: tx1, quantity: '5' }]));
        await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId1, 'http_get', 'ok', '', HOLDER], caller: HOLDER });

        const req2 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        assertSuccess(req2, 'requestClaim should be callable again once the previous check settled');
        const requestId2 = JSON.parse(req2.returnValue);
        const tx2 = nextTxHash();
        seedSendsResponse(requestId2, sendsPayload([
            { txHash: tx1, quantity: '5' },
            { txHash: tx2, quantity: '1' }
        ]));
        const cb2 = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId2, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        assertSuccess(cb2);
        assertEmittedActions(cb2, [{ action: 'SEND', params: { destination: HOLDER, tick: XC_TICK, quantity: '1' } }]);
        assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '6');
    });
}
