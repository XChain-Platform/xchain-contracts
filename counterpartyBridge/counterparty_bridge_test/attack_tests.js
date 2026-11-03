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
        ADDR, HOLDER, OTHER, XC_TICK, CODE, assert, assertSuccess, assertReverted, assertEmittedActions,
        assertContractState, deployBridge, getHarness, seedSendsResponse,
        sendsPayload, nextTxHash
    } = context;

    async function overCapRound(h, quantity) {
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        assertSuccess(req);
        const requestId = JSON.parse(req.returnValue);
        const txHash = nextTxHash();
        seedSendsResponse(requestId, sendsPayload([{ txHash: txHash, quantity: quantity }]));
        const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
        return { cb: cb, txHash: txHash };
    }

    it('a page that would exceed maxSupply settles as a no-op: no SEND, pending cleared, requestClaim callable again', async function () {
        await deployBridge('50', '8');
        const h = getHarness();
        const r = await overCapRound(h, '100');
        assertSuccess(r.cb, 'an over-cap page must not revert: that would roll back the pending delete');
        assertEmittedActions(r.cb, []);
        assert.strictEqual(h.ledger.getContractBalance(ADDR, XC_TICK), '50', 'custody is untouched by a refused claim');
        assertContractState(h.ledger, ADDR, 'totalClaimed', '0');
        assert.ok(!h.ledger.contractState[ADDR]['burned:' + r.txHash], 'the refused burn stays unmarked');
        assert.ok(!h.ledger.contractState[ADDR]['pending:' + HOLDER], 'pending is cleared');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }), 'address is not locked out');
    });

    it('at 18 decimals, a page of 1.000000000000000001 over a 9.999999999999999999 claim of maxSupply 10 is a no-op, not a wedge', async function () {
        await deployBridge('10', '18');
        const h = getHarness();
        const first = await overCapRound(h, '9.999999999999999999');
        assertSuccess(first.cb);
        assertContractState(h.ledger, ADDR, 'totalClaimed', '9.999999999999999999');
        const over = await overCapRound(h, '1.000000000000000001');
        assertSuccess(over.cb);
        assertEmittedActions(over.cb, []);
        assertContractState(h.ledger, ADDR, 'totalClaimed', '9.999999999999999999');
        assert.ok(!h.ledger.contractState[ADDR]['burned:' + over.txHash]);
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
    });

    it('after the exact supply is claimed, one more base unit is a no-op and requestClaim stays callable', async function () {
        await deployBridge('10', '18');
        const h = getHarness();
        assertSuccess((await overCapRound(h, '10')).cb);
        assertContractState(h.ledger, ADDR, 'totalClaimed', '10');
        const extra = await overCapRound(h, '0.000000000000000001');
        assertSuccess(extra.cb);
        assertEmittedActions(extra.cb, []);
        assertContractState(h.ledger, ADDR, 'totalClaimed', '10');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
    });

    // XChain MINT is not issuer-gated, so an unlocked tick could be minted by anyone:
    // unbacked supply, and a filled cap that strands every real claimant.
    it('public MINT of the bridged tick is locked: the deploy pre-mints maxSupply into custody', async function () {
        const deployed = await deployBridge('50', '8');
        const issues = deployed.result.emittedActions.filter(function (e) { return e.action === 'ISSUE'; });
        assert.strictEqual(issues.length, 1, 'the deploy emits exactly one ISSUE');
        assert.strictEqual(issues[0].params.tick, XC_TICK);
        assert.strictEqual(issues[0].params.mintSupply, '50', 'the whole maxSupply is pre-minted into custody');
        assert.strictEqual(issues[0].params.maxSupply, '50');
        assert.strictEqual(issues[0].params.lockMint, '1', 'MINT is locked for every address, the contract included');
        assert.strictEqual(issues[0].params.lockMintSupply, '1', 'no later ISSUE can add MINT_SUPPLY');
    });

    it('no bridge method emits a MINT', function () {
        assert.strictEqual(CODE.indexOf('emit.mint'), -1, 'a MINT of a LOCK_MINT tick is refused by the indexer');
    });
}
