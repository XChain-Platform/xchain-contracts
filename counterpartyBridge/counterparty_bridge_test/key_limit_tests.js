'use strict';

module.exports = function registerKeyLimitTests(context) {
    registerHashShapeTests(context);
    registerCapacityTests(context);
};

function makeClaim(context) {
    const {
        ADDR, HOLDER, assertSuccess, getHarness, seedSendsResponse, sendsPayload
    } = context;
    return async function claim(rows) {
        const h = getHarness();
        const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
        assertSuccess(req);
        const id = JSON.parse(req.returnValue);
        seedSendsResponse(id, sendsPayload(rows));
        return h.execute({ contractAddress: ADDR, method: 'onClaim', params: [id, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
    };
}

function registerHashShapeTests(context) {
    const { ADDR, HOLDER, assertSuccess, assertEmittedActions, assertContractState,
        deployBridge, getHarness, nextTxHash } = context;
    const claim = makeClaim(context);

    it('drops unstorable and non-hex tx_hash rows while crediting a valid row', async function () {
        await deployBridge();
        const valid = nextTxHash();
        const rows = [valid, 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64),
            'a\u0000' + 'b'.repeat(62), '\ud83d\ude00' + 'a'.repeat(63), 'a'.repeat(300)]
            .map(value => ({ txHash: value, quantity: '1' }));
        const result = await claim(rows);
        assertSuccess(result);
        assertEmittedActions(result, [{ action: 'SEND', params: {
            destination: HOLDER, tick: context.XC_TICK, quantity: '1', memo: 'counterpartyBridge claim'
        } }]);
        assertContractState(getHarness().ledger, ADDR, 'burned:' + valid, true);
        assertContractState(getHarness().ledger, ADDR, 'totalClaimed', '1');
    });

    it('normalizes uppercase tx_hash text before nullifier lookup', async function () {
        await deployBridge();
        assertSuccess(await claim([{ txHash: 'A'.repeat(64), quantity: '2' }]));
        const replay = await claim([{ txHash: 'a'.repeat(64), quantity: '2' }]);
        assertSuccess(replay);
        assertEmittedActions(replay, []);
        assertContractState(getHarness().ledger, ADDR, 'totalClaimed', '2');
    });
}

function registerCapacityTests(context) {
    const { assert, ADDR, HOLDER, CODE, assertSuccess, assertReverted,
        assertEmittedActions, assertContractState, deployBridge, getHarness, nextTxHash } = context;
    const claim = makeClaim(context);
    it('fails soft at the credit-key ceiling and clears the pending slot', async function () {
        await deployBridge();
        const h = getHarness();
        h.ledger.contractState[ADDR].creditKeys = '9000';
        const result = await claim([{ txHash: nextTxHash(), quantity: '3' }]);
        assertSuccess(result);
        assertEmittedActions(result, []);
        assertContractState(h.ledger, ADDR, 'totalClaimed', '0');
        assert.ok(!h.ledger.contractState[ADDR]['pending:' + HOLDER]);
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
    });

    it('refuses a new request when the pending-key ceiling is full', async function () {
        await deployBridge();
        const h = getHarness();
        h.ledger.contractState[ADDR].pendingCount = '900';
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }),
            'too many claim checks');
    });

    it('reserves enough state-key headroom for fixed configuration keys', function () {
        const credit = Number(CODE.match(/MAX_CREDIT_KEYS = (\d+)/)[1]);
        const pending = Number(CODE.match(/MAX_PENDING = (\d+)/)[1]);
        assert.ok(credit + pending + 20 < 10000,
            'dynamic key ceilings must leave fixed-key headroom');
    });
}
