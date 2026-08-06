// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// counterpartyBridge.test.js: behavioral + adversarial tests for counterpartyBridge.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL counterpartyBridge.js template (no copy), so the test can
// never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/counterpartyBridge/counterpartyBridge.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping counterpartyBridge tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'counterpartyBridge.js'), 'utf8');

const ADDR       = 'C:BTC:1';
const HOLDER     = '1HolderBtcAddress11111111111111111';
const OTHER      = '1OtherBtcAddress222222222222222222';
const CP_ASSET   = 'XCPCARD';
const XC_TICK    = 'BRIDGEDCARD';
const MAX_SUPPLY = '1000000';

(XChainVM ? describe : describe.skip)('Template: counterpartyBridge', function () {
    this.timeout(0);
    let h;

    async function deployBridge(maxSupply, decimals) {
        h = new E2EHarness(XChainVM);
        await h.deploy({
            code: CODE, deployer: HOLDER, contractAddress: ADDR,
            params: [CP_ASSET, XC_TICK, maxSupply || MAX_SUPPLY, decimals || '8']
        });
    }

    // Seeds a settled attestation response on the harness's MockLedger, the
    // way the indexer would after off-chain providers agree on the balances
    // API's body. h.execute() reads it via ledger.buildAttestationAccessor().
    function seedBalanceResponse(requestId, payload, status) {
        h.ledger.seedAttestation(requestId, {
            status: status || 'ok', payload: payload, providerId: 'http_get', blockIndex: 200, validatorCount: 3
        });
    }

    // Shape of a real tokenscan.io GET /api/balances/{address}/{page}/{limit}
    // response (see https://tokenscan.io/api#balances): a wallet's entire
    // holdings as an array, `quantity` already a normalized decimal string.
    function balancePayload(quantity, asset) {
        return JSON.stringify({
            address: HOLDER,
            data: [
                { asset: 'XCP', asset_longname: '', description: '', estimated_value: {}, quantity: '10.00000000' },
                { asset: asset || CP_ASSET, asset_longname: '', description: '', estimated_value: {}, quantity: quantity }
            ],
            total: 2
        });
    }

    describe('happy path: claim mints the bridged equivalent', function () {
        it('requestClaim -> onClaim with a positive balance mints to the claiming address', async function () {
            await deployBridge();

            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(req);
            assertEmittedActions(req, [{ action: 'ATTEST', params: {
                providerId: 'http_get', callbackMethod: 'onClaim'
            } }]);
            const requestId = JSON.parse(req.returnValue);
            assertContractState(h.ledger, ADDR, 'pending:' + HOLDER, requestId);

            seedBalanceResponse(requestId, balancePayload('42.5'));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'relayer' });
            assertSuccess(cb);
            assertEmittedActions(cb, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '42.5', destination: HOLDER } }]);
            assertContractState(h.ledger, ADDR, 'claimed:' + HOLDER, '42.5');
            assertContractState(h.ledger, ADDR, 'totalClaimed', '42.5');
            assert.ok(!('pending:' + HOLDER in h.ledger.getContractState(ADDR)), 'pending cleared after settlement');
        });

        it('anyone can relay the callback - the attestation itself is the authorization, not the caller', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedBalanceResponse(requestId, balancePayload('10'));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'stranger' });
            assertSuccess(cb, 'a stranger can relay a settled callback');
        });

        it('picks the matching asset out of a wallet holding several Counterparty assets', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            // balancePayload() already seeds an unrelated XCP row alongside cpAsset.
            seedBalanceResponse(requestId, balancePayload('7.00000000'));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb);
            assertContractState(h.ledger, ADDR, 'claimed:' + HOLDER, '7.00000000');
        });
    });

    describe('no balance / failure: no-op, not fatal', function () {
        it('a zero balance is a no-op: pending clears, nothing minted, address stays unclaimed', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedBalanceResponse(requestId, balancePayload('0'));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'zero balance is a no-op, not a revert');
            assertEmittedActions(cb, []);
            assert.ok(!xchainHasState(h, 'claimed:' + HOLDER), 'address not marked claimed');

            // Retry now succeeds because pending was cleared.
            const retry = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(retry, 'requestClaim should be callable again after a zero-balance check cleared pending');
        });

        it('cpAsset simply absent from the wallet\'s holdings is a no-op, not an error', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            // Wallet holds XCP and some other asset, but not cpAsset.
            seedBalanceResponse(requestId, JSON.stringify({
                address: HOLDER,
                data: [{ asset: 'XCP', asset_longname: '', description: '', estimated_value: {}, quantity: '10.00000000' }],
                total: 1
            }));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'asset not held is a no-op, not a revert');
            assertEmittedActions(cb, []);
        });

        it('a malformed / non-JSON body is treated as no balance found, not a crash', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedBalanceResponse(requestId, 'not json at all');
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'malformed body should not crash the callback');
            assertEmittedActions(cb, []);
        });

        it('a failed attestation is also a no-op', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedBalanceResponse(requestId, '', 'failed');
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb);
            assertEmittedActions(cb, []);
        });

        it('requestClaim rejects a second check while one is already pending for that address', async function () {
            await deployBridge();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }),
                'already pending');
        });

        it('a pending check for one address does not block another address', async function () {
            await deployBridge();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }));
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: OTHER }));
        });
    });

    describe('attacks we considered', function () {
        it('onClaim rejects a request_id that is not the outstanding one for this address (no stale-response replay)', async function () {
            await deployBridge();
            await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });

            const forged = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
            seedBalanceResponse(forged, balancePayload('999'));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [forged, 'http_get', 'ok', '', HOLDER], caller: 'attacker' });
            assertReverted(cb, 'not the outstanding claim request');
        });

        it('a stale response cannot be replayed against a DIFFERENT address (address is part of the callback params)', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedBalanceResponse(requestId, balancePayload('999'));

            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', OTHER], caller: 'attacker' });
            assertReverted(cb, 'not the outstanding claim request');
        });

        it('onClaim reverts if the response has not settled yet', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertReverted(cb, 'no response yet');
        });

        it('double-claim is impossible: a second requestClaim after a successful claim is rejected', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedBalanceResponse(requestId, balancePayload('42.5'));
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER }));

            assertReverted(await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER }),
                'already claimed');
        });

        it('a late-arriving onClaim replay after a successful claim is a harmless no-op (defense in depth)', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedBalanceResponse(requestId, balancePayload('42.5'));
            await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });

            // Same requestId is still "the outstanding one" would be false now (pending
            // was cleared), so replay must hit the 'already claimed' short-circuit path
            // instead - exercised by re-seeding a fresh pending entry to isolate it.
            // (Direct MockLedger object mutation - there is no setContractState helper.)
            h.ledger.contractState[ADDR]['pending:' + HOLDER] = requestId;
            const replay = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'attacker' });
            assertSuccess(replay, 'settled-elsewhere (already claimed) callback should not revert');
            assertEmittedActions(replay, []);
            assertContractState(h.ledger, ADDR, 'claimed:' + HOLDER, '42.5'); // unchanged, no double mint
        });

        it('minting is capped at maxSupply across all claimants', async function () {
            await deployBridge('50', '8');
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedBalanceResponse(requestId, balancePayload('100'));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertReverted(cb, 'maxSupply exhausted');
        });
    });

    describe('deploy-time validation', function () {
        it('rejects an empty cpAsset', async function () {
            const bad = new E2EHarness(XChainVM);
            const r = await bad.deploy({
                code: CODE, deployer: HOLDER, contractAddress: 'C:BTC:2',
                params: ['', XC_TICK, MAX_SUPPLY, '8']
            });
            assert.strictEqual(r.success, false, 'deploy with an empty cpAsset should revert in initialize');
        });

        it('rejects an out-of-range decimals value', async function () {
            const bad = new E2EHarness(XChainVM);
            const r = await bad.deploy({
                code: CODE, deployer: HOLDER, contractAddress: 'C:BTC:3',
                params: [CP_ASSET, XC_TICK, MAX_SUPPLY, '19']
            });
            assert.strictEqual(r.success, false, 'deploy with decimals > 18 should revert in initialize');
        });
    });
});

// Small helper: true if the contract's state object has the given key set.
function xchainHasState(h, key) {
    return key in h.ledger.getContractState(ADDR);
}
