// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// urlOracle.test.js: proves the attestation (off-chain URL) round-trip.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm (isolated-vm / Node 22). Loads the
// ACTUAL urlOracle.js template so the test can't drift.
//
// Run from the xchain-vm package so its deps resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/urlOracle/urlOracle.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
} catch (e) { XChainVM = null; console.log('Skipping urlOracle tests: isolated-vm not available (need Node 22):', e.message); }

const CODE = fs.readFileSync(path.join(__dirname, 'urlOracle.js'), 'utf8');

const GAS_SCHEDULE = {
    VM_COMPUTATION:     1,
    VM_STATE_READ:      100,
    VM_STATE_WRITE:     200,
    VM_STATE_DELETE:    100,
    VM_ORACLE_READ:     100,
    VM_CROSSCHAIN_READ: 100,
    VM_ATTEST_REQUEST:  5000,
    VM_EMISSION:        500,
    VM_XCALL_REQUEST:   2000,
    VM_XCALL_CALLBACK:  20000
};

function createVM() {
    return new XChainVM({
        gasSchedule: GAS_SCHEDULE,
        gasCeiling:  1000000,
        limits: {
            maxCpuTimeMs:      5000,
            maxMemory:         8,
            maxEmissions:      50,
            maxStateKeys:      10000,
            maxStateValueSize: 65536,
            maxCodeSize:       65536
        }
    });
}

// Carry state forward between executions the way the indexer would.
function applyState(prev, result) {
    const s = { ...prev };
    for (const { key, value } of result.stateChanges) s[key] = value;
    for (const key of result.stateDeletes) delete s[key];
    return s;
}

function baseExecOpts(extra) {
    return Object.assign({
        code:            CODE,
        state:           {},
        method:          'default',
        params:          [],
        caller:          'addr1',
        contractAddress: 'C:BTC:1',
        contractIndex:   1,
        txHash:          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        blockContext:    { height: 100, timestamp: 1700000000, hash: 'abc' }
    }, extra || {});
}

const URL = 'https://api.example.com/btc/price';

(XChainVM ? describe : describe.skip)('Template: urlOracle (off-chain URL via attestation)', function () {
    this.timeout(0);

    let vm;
    before(function () { vm = createVM(); });

    // Deploy-parity gate. The rest of this suite drives vm.execute() directly,
    // which compiles the source but does NOT run the deploy linter: exec-time
    // re-linting is gated on isExecLintActive(network, ...) and baseExecOpts
    // carries no `network`, so the banned-async / banned-generator / Math-subset
    // rules are never evaluated against urlOracle.js on that path. Every sibling
    // template test deploys through E2EHarness.deploy(), which calls
    // vm.validateSyntax(code) - the real deploy gate. Without these two cases an
    // edit that introduced a banned surface into urlOracle.js would keep this
    // suite green while a real deploy rejected it.
    describe('deploy gate (parity with the sibling template suites)', function () {

        it('the real urlOracle.js source passes E2EHarness.deploy()', async function () {
            const h = new E2EHarness(XChainVM);
            const d = await h.deploy({ code: CODE, deployer: 'addr1', contractAddress: 'C:BTC:1' });
            // urlOracle exports no initialize, so deploy() succeeds via the
            // unknown-method path once validateSyntax has passed.
            assert.strictEqual(d.success, true, 'deploy should pass the linter: ' + d.error);
        });

        // Negative control. Without it the case above is satisfied by a gate that
        // never ran, which is exactly the failure this block exists to catch.
        it('the gate is live: an async-surface edit to the same source is rejected', async function () {
            const banned = CODE.replace('requestPrice: function (xchain) {',
                                        'requestPrice: async function (xchain) {');
            assert.notStrictEqual(banned, CODE, 'the mutation must actually apply');
            const h = new E2EHarness(XChainVM);
            const d = await h.deploy({ code: banned, deployer: 'addr1', contractAddress: 'C:BTC:2' });
            assert.strictEqual(d.success, false, 'the deploy linter must reject an async surface');
            assert.match(String(d.error), /banned async surface/);
        });
    });

    describe('requestPrice()', function () {

        it('emits an ATTEST http_get for the URL and returns a 64-hex request_id', async function () {
            const result = await vm.execute(baseExecOpts({
                method: 'requestPrice',
                params: [URL]
            }));
            assert.strictEqual(result.success, true, 'should succeed: ' + result.error);

            // The contract "accesses the URL" by emitting a request, not by fetching.
            assert.strictEqual(result.emittedActions.length, 1);
            const att = result.emittedActions[0];
            assert.strictEqual(att.action, 'ATTEST');
            assert.strictEqual(att.params.providerId, 'http_get');
            assert.strictEqual(att.params.requestPayload, URL);
            assert.strictEqual(att.params.callbackMethod, 'onPrice');

            const requestId = JSON.parse(result.returnValue);
            assert.match(requestId, /^[0-9a-f]{64}$/);

            // request_id is remembered in state for callback correlation.
            const pending = result.stateChanges.find(c => c.key === 'pending');
            assert.ok(pending && pending.value === requestId, 'pending request_id stored in state');

            // Costs at least VM_ATTEST_REQUEST + VM_EMISSION.
            assert.ok(result.gasUsed >= 5500, 'gas should be >= 5500, got ' + result.gasUsed);
        });

        it('reverts when no URL is supplied', async function () {
            const result = await vm.execute(baseExecOpts({ method: 'requestPrice', params: [] }));
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /url required/);
        });
    });

    describe('onPrice() callback round-trip', function () {

        it('commits the settled URL body to state once the response is available', async function () {
            // 1. Contract requests the URL.
            const req = await vm.execute(baseExecOpts({ method: 'requestPrice', params: [URL] }));
            assert.strictEqual(req.success, true, req.error);
            const requestId = JSON.parse(req.returnValue);
            const stateAfterReq = applyState({}, req);

            // 2. Off-chain providers fetched the URL and the indexer settled the
            //    body; we simulate that settled response here.
            const SETTLED_BODY = '42000.50';
            const attestationData = {
                getResponse: (id) => id === requestId
                    ? { status: 'ok', payload: SETTLED_BODY, providerId: 'http_get', blockIndex: 101, validatorCount: 1 }
                    : null
            };

            // 3. Indexer calls the contract back: onPrice(requestId).
            const cb = await vm.execute(baseExecOpts({
                method: 'onPrice',
                params: [requestId],
                state:  stateAfterReq,
                attestationData
            }));
            assert.strictEqual(cb.success, true, 'callback should succeed: ' + cb.error);
            assert.strictEqual(JSON.parse(cb.returnValue), SETTLED_BODY);

            const stateAfterCb = applyState(stateAfterReq, cb);
            assert.strictEqual(stateAfterCb.price, SETTLED_BODY, 'URL body persisted as price');
            assert.ok(!('pending' in stateAfterCb), 'pending cleared after settlement');

            // 4. price() reads it back.
            const read = await vm.execute(baseExecOpts({ method: 'price', state: stateAfterCb }));
            assert.strictEqual(read.success, true, read.error);
            assert.strictEqual(JSON.parse(read.returnValue), SETTLED_BODY);
        });

        it('reverts if the callback runs before the response has settled', async function () {
            const result = await vm.execute(baseExecOpts({
                method: 'onPrice',
                params: ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
                attestationData: { getResponse: () => null }
            }));
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /no response yet/);
        });

        it('reverts if the providers could not fulfill the request', async function () {
            const result = await vm.execute(baseExecOpts({
                method: 'onPrice',
                params: ['ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'],
                attestationData: { getResponse: () => ({ status: 'failed', payload: '', providerId: 'http_get' }) }
            }));
            assert.strictEqual(result.success, false);
            assert.match(String(result.error), /attestation failed: failed/);
        });
    });
});
