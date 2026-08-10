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

const ADDR         = 'C:BTC:1';
const HOLDER       = '1HolderBtcAddress11111111111111111';
const OTHER        = '1OtherBtcAddress222222222222222222';
const CP_ASSET     = 'XCPCARD';
const XC_TICK      = 'BRIDGEDCARD';
const MAX_SUPPLY   = '1000000';
const BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE';

let txCounter = 0;
function nextTxHash() { txCounter += 1; return 'tx' + String(txCounter).padStart(62, '0'); }

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
    // way the indexer would after off-chain providers agree on the sends
    // API's body. h.execute() reads it via ledger.buildAttestationAccessor().
    function seedSendsResponse(requestId, payload, status) {
        h.ledger.seedAttestation(requestId, {
            status: status || 'ok', payload: payload, providerId: 'http_get', blockIndex: 200, validatorCount: 3
        });
    }

    // Shape of a real tokenscan.io GET /api/sends/{address}/{page}/{limit}
    // response (see https://tokenscan.io/api#sends): every Send that ever
    // landed on BURN_ADDRESS, across every asset and every sender.
    function sendsPayload(rows) {
        return JSON.stringify({
            data: rows.map(function (r) {
                return {
                    asset: r.asset || CP_ASSET,
                    asset_longname: '',
                    block_index: r.blockIndex || 900000,
                    destination: BURN_ADDRESS,
                    quantity: r.quantity,
                    source: r.source || HOLDER,
                    status: r.status || 'valid',
                    timestamp: 1700000000,
                    tx_hash: r.txHash,
                    tx_index: r.txIndex || 1
                };
            }),
            total: rows.length
        });
    }

    describe('happy path: claim mints the bridged equivalent', function () {
        it('requestClaim -> onClaim with a matching burn mints to the claiming address', async function () {
            await deployBridge();

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
            assertEmittedActions(cb, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '42.5', destination: HOLDER } }]);
            assertContractState(h.ledger, ADDR, 'burned:' + txHash, true);
            assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '42.5');
            assertContractState(h.ledger, ADDR, 'totalClaimed', '42.5');
            assert.ok(!('pending:' + HOLDER in h.ledger.getContractState(ADDR)), 'pending cleared after settlement');
        });

        it('anyone can relay the callback - the attestation itself is the authorization, not the caller', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedSendsResponse(requestId, sendsPayload([{ txHash: nextTxHash(), quantity: '10' }]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'stranger' });
            assertSuccess(cb, 'a stranger can relay a settled callback');
        });

        it('sums multiple burn transactions from the same address in one claim', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            const tx1 = nextTxHash(), tx2 = nextTxHash();
            seedSendsResponse(requestId, sendsPayload([
                { txHash: tx1, quantity: '5' },
                { txHash: tx2, quantity: '2.5' }
            ]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb);
            assertEmittedActions(cb, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '7.5', destination: HOLDER } }]);
            assertContractState(h.ledger, ADDR, 'burned:' + tx1, true);
            assertContractState(h.ledger, ADDR, 'burned:' + tx2, true);
        });

        it('ignores burns from other sources, other assets, and other statuses in the shared burn-address feed', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            const mine = nextTxHash();
            seedSendsResponse(requestId, sendsPayload([
                { txHash: nextTxHash(), quantity: '999', source: OTHER },              // someone else's burn
                { txHash: nextTxHash(), quantity: '999', asset: 'SOMEOTHERASSET' },     // unrelated asset, same burn address
                { txHash: nextTxHash(), quantity: '999', status: 'invalid' },           // invalid send
                { txHash: mine, quantity: '3' }
            ]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb);
            assertEmittedActions(cb, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '3', destination: HOLDER } }]);
        });

        it('a later requestClaim only mints the burns that were not already credited', async function () {
            await deployBridge();
            const req1 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId1 = JSON.parse(req1.returnValue);
            const tx1 = nextTxHash();
            seedSendsResponse(requestId1, sendsPayload([{ txHash: tx1, quantity: '5' }]));
            await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId1, 'http_get', 'ok', '', HOLDER], caller: HOLDER });

            const req2 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(req2, 'requestClaim should be callable again once the previous check settled');
            const requestId2 = JSON.parse(req2.returnValue);
            const tx2 = nextTxHash();
            // Feed now reports BOTH the old (already-credited) burn and a new one.
            seedSendsResponse(requestId2, sendsPayload([
                { txHash: tx1, quantity: '5' },
                { txHash: tx2, quantity: '1' }
            ]));
            const cb2 = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId2, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb2);
            assertEmittedActions(cb2, [{ action: 'MINT', params: { tick: XC_TICK, quantity: '1', destination: HOLDER } }]);
            assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '6');
        });
    });

    describe('no burns / failure: no-op, not fatal', function () {
        it('no matching burns is a no-op: pending clears, nothing minted', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedSendsResponse(requestId, sendsPayload([]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'no burns is a no-op, not a revert');
            assertEmittedActions(cb, []);

            // Retry now succeeds because pending was cleared.
            const retry = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            assertSuccess(retry, 'requestClaim should be callable again after a no-burns check cleared pending');
        });

        it('a malformed / non-JSON body is treated as no burns found, not a crash', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedSendsResponse(requestId, 'not json at all');
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb, 'malformed body should not crash the callback');
            assertEmittedActions(cb, []);
        });

        it('a failed attestation is also a no-op', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);

            seedSendsResponse(requestId, '', 'failed');
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
            seedSendsResponse(forged, sendsPayload([{ txHash: nextTxHash(), quantity: '999' }]));
            const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [forged, 'http_get', 'ok', '', HOLDER], caller: 'attacker' });
            assertReverted(cb, 'not the outstanding claim request');
        });

        it('a stale response cannot be replayed against a DIFFERENT address (address is part of the callback params)', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedSendsResponse(requestId, sendsPayload([{ txHash: nextTxHash(), quantity: '999' }]));

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

        it('the same burn tx_hash can never be credited twice, even across separate requestClaim rounds', async function () {
            await deployBridge();
            const req1 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId1 = JSON.parse(req1.returnValue);
            const tx1 = nextTxHash();
            seedSendsResponse(requestId1, sendsPayload([{ txHash: tx1, quantity: '42.5' }]));
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId1, 'http_get', 'ok', '', HOLDER], caller: HOLDER }));

            const req2 = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId2 = JSON.parse(req2.returnValue);
            // Feed re-reports the SAME burn tx (e.g. a stale/duplicated page) and nothing else.
            seedSendsResponse(requestId2, sendsPayload([{ txHash: tx1, quantity: '42.5' }]));
            const cb2 = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId2, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
            assertSuccess(cb2, 'an already-credited burn is a harmless no-op, not a double mint');
            assertEmittedActions(cb2, []);
            assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '42.5');
        });

        it('a late-arriving onClaim replay of the same settled response is a harmless no-op (defense in depth)', async function () {
            await deployBridge();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            const txHash = nextTxHash();
            seedSendsResponse(requestId, sendsPayload([{ txHash: txHash, quantity: '42.5' }]));
            await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });

            // pending was cleared by the first callback; re-seed it (direct
            // MockLedger mutation - there is no setContractState helper) to
            // isolate the burned-tx_hash nullifier from the pending-pin check.
            h.ledger.contractState[ADDR]['pending:' + HOLDER] = requestId;
            const replay = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: 'attacker' });
            assertSuccess(replay, 'replaying an already-credited burn should not revert');
            assertEmittedActions(replay, []);
            assertContractState(h.ledger, ADDR, 'claimedTotal:' + HOLDER, '42.5'); // unchanged, no double mint
        });

        it('minting is capped at maxSupply across all claimants', async function () {
            await deployBridge('50', '8');
            const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
            const requestId = JSON.parse(req.returnValue);
            seedSendsResponse(requestId, sendsPayload([{ txHash: nextTxHash(), quantity: '100' }]));
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
