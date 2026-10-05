'use strict';

module.exports = function registerAttackTests(context) {
    describe('attacks we considered', function () {
        registerStaleResponseAttacks(context);
        registerDoubleCreditAttacks(context);
        registerSupplyCapAttack(context);
    });
};

function registerStaleResponseAttacks(context) {
    const {
        ADDR, HOLDER, OTHER, assertSuccess, assertReverted, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    it('onClaim rejects a request_id that is not the outstanding one for this address (no stale-response replay)', async function () {
        await deployBridge();
        const h = getHarness();
        await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });

        const forged = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
        seedSendsResponse(forged, sendsPayload([{ txHash: nextTxHash(), quantity: '999' }]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [forged, 'http_get', 'ok', '', HOLDER], caller: 'attacker' });
        assertReverted(cb, 'not the outstanding claim request');
    });

    it('a stale response cannot be replayed against a DIFFERENT address (address is part of the callback params)', async function () {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);
        seedSendsResponse(requestId, sendsPayload([{ txHash: nextTxHash(), quantity: '999' }]));

        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', OTHER], caller: 'attacker' });
        assertReverted(cb, 'not the outstanding claim request');
    });

    it('onClaim reverts if the response has not settled yet', async function () {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);

        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        assertReverted(cb, 'no response yet');
    });
}

function registerDoubleCreditAttacks(context) {
    const {
        ADDR, HOLDER, OTHER, assertSuccess, assertReverted, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    it('the same burn tx_hash can never be credited twice, even across separate requestClaim rounds', async function () {
        await deployBridge();
        const h = getHarness();
        const req1 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId1 = JSON.parse(req1.returnValue);
        const tx1 = nextTxHash();
        seedSendsResponse(requestId1, sendsPayload([{ txHash: tx1, quantity: '42.5' }]));
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId1, 'http_get', 'ok', '', HOLDER], caller: HOLDER }));

        const req2 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId2 = JSON.parse(req2.returnValue);
        seedSendsResponse(requestId2, sendsPayload([{ txHash: tx1, quantity: '42.5' }]));
        const cb2 = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId2, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        assertSuccess(cb2, 'an already-credited burn is a harmless no-op, not a double mint');
        assertEmittedActions(cb2, []);
        assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '42.5');
    });

    it('a late-arriving onClaim replay of the same settled response is a harmless no-op (defense in depth)', async function () {
        await deployBridge();
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);
        const txHash = nextTxHash();
        seedSendsResponse(requestId, sendsPayload([{ txHash: txHash, quantity: '42.5' }]));
        await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });

        h.ledger.contractState[ADDR]['pending:' + HOLDER] = requestId;
        const replay = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'attacker' });
        assertSuccess(replay, 'replaying an already-credited burn should not revert');
        assertEmittedActions(replay, []);
        assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '42.5');
    });
}

function registerSupplyCapAttack(context) {
    const {
        ADDR, HOLDER, OTHER, assertSuccess, assertReverted, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    it('minting is capped at maxSupply across all claimants', async function () {
        await deployBridge('50', '8');
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        const requestId = JSON.parse(req.returnValue);
        seedSendsResponse(requestId, sendsPayload([{ txHash: nextTxHash(), quantity: '100' }]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        assertReverted(cb, 'maxSupply exhausted');
    });
}
