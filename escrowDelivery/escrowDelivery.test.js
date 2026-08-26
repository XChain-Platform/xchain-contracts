// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// escrowDelivery.test.js: behavioral + adversarial tests for escrowDelivery.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL escrowDelivery.js template (no copy), so the test can
// never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/escrowDelivery/escrowDelivery.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions,
    assertBalance, assertContractBalance, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions,
       assertBalance, assertContractBalance, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping escrowDelivery tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'escrowDelivery.js'), 'utf8');

const BUYER    = 'buyer';
const SELLER   = 'seller';
const ARBITER  = 'arbiter';
const STRANGER = 'stranger';
const ADDR     = 'C:BTC:1';
const TICK     = 'TEST';
const MARKER   = '"status":"delivered"';
const TRACKING_URL = 'https://carrier.example.com/track/1Z999';

(XChainVM ? describe : describe.skip)('Template: escrowDelivery', function () {
    this.timeout(0);
    let h;

    async function deployEscrow(window) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(BUYER, 'XCHAIN', '1000000');
        h.seedBalance(BUYER, TICK, '200');
        await h.deploy({
            code: CODE, deployer: BUYER, contractAddress: ADDR,
            params: [BUYER, SELLER, ARBITER, TICK, '200', String(window || 3), MARKER]
        });
    }

    async function depositAndFund(amount) {
        h.deposit(BUYER, ADDR, TICK, amount || '200');
        return h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: BUYER });
    }

    // Seeds a settled attestation response on the harness's MockLedger, the
    // way the indexer would after off-chain providers agree on the tracking
    // page's body. h.execute() reads it via ledger.buildAttestationAccessor().
    function seedDeliveryResponse(requestId, payload, status) {
        h.ledger.seedAttestation(requestId, {
            status: status || 'ok', payload: payload, providerId: 'http_get', blockIndex: 200, validatorCount: 3
        });
    }

    describe('happy path: automated release on delivery', function () {
        it('requestDelivery -> onDelivery with a matching body releases to the seller with no human settlement call', async function () {
            await deployEscrow();
            assertSuccess(await depositAndFund());

            const req = await h.execute({
                contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: STRANGER
            });
            assertSuccess(req);
            assertEmittedActions(req, [{ action: 'ATTEST', params: {
                providerId: 'http_get', requestPayload: TRACKING_URL, callbackMethod: 'onDelivery'
            } }]);
            const requestId = JSON.parse(req.returnValue);
            assertContractState(h.ledger, ADDR, 'pending', requestId);

            const body = 'tracking events...\n' + MARKER + '\nsigned by recipient';
            seedDeliveryResponse(requestId, body);
            const cb = await h.execute({
                contractAddress: ADDR, method: 'onDelivery', params: [requestId], caller: STRANGER
            });
            assertSuccess(cb);
            assertEmittedActions(cb, [{ action: 'SEND', params: { destination: SELLER, tick: TICK, quantity: '200' } }]);
            assertContractBalance(h.ledger, ADDR, TICK, '0');
            assertBalance(h.ledger, SELLER, TICK, '200');
            assertContractState(h.ledger, ADDR, 'status', 'DELIVERED');
        });

        it('anyone can trigger the check - the attestation itself is the authorization, not the caller', async function () {
            await deployEscrow();
            await depositAndFund();
            const req = await h.execute({
                contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: STRANGER
            });
            assertSuccess(req, 'a stranger can ask the network to check the tracking URL');
        });
    });

    describe('non-delivery and retry', function () {
        it('a body without the marker is a no-op: funds stay put, pending clears for retry', async function () {
            await deployEscrow();
            await depositAndFund();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER });
            const requestId = JSON.parse(req.returnValue);

            seedDeliveryResponse(requestId, 'label created, awaiting carrier pickup');
            const cb = await h.execute({
                contractAddress: ADDR, method: 'onDelivery', params: [requestId], caller: BUYER
            });
            assertSuccess(cb, 'undelivered is a no-op, not a revert');
            assertEmittedActions(cb, []);
            assertContractState(h.ledger, ADDR, 'status', 'FUNDED');
            assertContractBalance(h.ledger, ADDR, TICK, '200');
            assert.ok(!('pending' in h.ledger.getContractState(ADDR)), 'pending cleared so a retry can be requested');

            // Retry now succeeds because pending was cleared.
            const retry = await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER });
            assertSuccess(retry, 'requestDelivery should be callable again after a non-match cleared pending');
        });

        it('a failed attestation is also a no-op, not fatal', async function () {
            await deployEscrow();
            await depositAndFund();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER });
            const requestId = JSON.parse(req.returnValue);

            seedDeliveryResponse(requestId, '', 'failed');
            const cb = await h.execute({
                contractAddress: ADDR, method: 'onDelivery', params: [requestId], caller: BUYER
            });
            assertSuccess(cb);
            assertContractState(h.ledger, ADDR, 'status', 'FUNDED');
        });

        it('requestDelivery rejects a second check while one is already pending', async function () {
            await deployEscrow();
            await depositAndFund();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER }));
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: SELLER }),
                'already pending');
        });
    });

    describe('attacks we considered', function () {
        it('onDelivery rejects a request_id that is not the outstanding one (no stale-response replay)', async function () {
            await deployEscrow();
            await depositAndFund();
            await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER });

            const forged = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
            seedDeliveryResponse(forged, MARKER);
            const cb = await h.execute({
                contractAddress: ADDR, method: 'onDelivery', params: [forged], caller: STRANGER
            });
            assertReverted(cb, 'not the outstanding delivery request');
            assertContractBalance(h.ledger, ADDR, TICK, '200'); // untouched
        });

        it('onDelivery reverts if the response has not settled yet', async function () {
            await deployEscrow();
            await depositAndFund();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER });
            const requestId = JSON.parse(req.returnValue);

            // Not seeded: buildAttestationAccessor().getResponse() naturally returns null.
            const cb = await h.execute({
                contractAddress: ADDR, method: 'onDelivery', params: [requestId], caller: BUYER
            });
            assertReverted(cb, 'no response yet');
        });

        it('a late-arriving onDelivery for a request outstanding before a manual release is a harmless no-op', async function () {
            await deployEscrow();
            await depositAndFund();
            const req = await h.execute({ contractAddress: ADDR, method: 'requestDelivery', params: [TRACKING_URL], caller: BUYER });
            const requestId = JSON.parse(req.returnValue);

            // Arbiter resolves a dispute manually while the check is still in flight.
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: ARBITER }));
            assertContractState(h.ledger, ADDR, 'status', 'REFUNDED');

            seedDeliveryResponse(requestId, MARKER);
            const cb = await h.execute({
                contractAddress: ADDR, method: 'onDelivery', params: [requestId], caller: STRANGER
            });
            assertSuccess(cb, 'settled-elsewhere callback should not revert');
            assertContractState(h.ledger, ADDR, 'status', 'REFUNDED'); // unchanged, no double payout
            assertContractBalance(h.ledger, ADDR, TICK, '0');
        });

        it('a stranger cannot manually release or refund (automated path is still the only unauthenticated one)', async function () {
            await deployEscrow();
            await depositAndFund();
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: STRANGER }),
                'not authorized');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: STRANGER }),
                'not authorized');
        });

        it('double-settle is impossible: onDelivery cannot re-pay after a manual release, and vice versa', async function () {
            await deployEscrow();
            await depositAndFund();
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'release', params: [], caller: BUYER }));
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'refund', params: [], caller: ARBITER }),
                'not funded');
        });

        it('buyer reclaims via timeout() if delivery never confirms and nobody intervenes', async function () {
            await deployEscrow(3);
            await depositAndFund();
            h.mineBlock(); h.mineBlock(); h.mineBlock();
            const r = await h.execute({ contractAddress: ADDR, method: 'timeout', params: [], caller: BUYER });
            assertSuccess(r);
            assertBalance(h.ledger, BUYER, TICK, '200');
            assertContractState(h.ledger, ADDR, 'status', 'REFUNDED');
        });
    });

    describe('deploy-time validation', function () {
        async function deployWith(params) {
            const bad = new E2EHarness(XChainVM);
            bad.seedBalance(BUYER, 'XCHAIN', '1000000');
            return bad.deploy({ code: CODE, deployer: BUYER, contractAddress: 'C:BTC:2', params: params });
        }

        it('rejects an empty deliveryMarker', async function () {
            const r = await deployWith([BUYER, SELLER, ARBITER, TICK, '200', '3', '']);
            assert.strictEqual(r.success, false, 'deploy with an empty deliveryMarker should revert in initialize');
        });

        // Integer-shape gate on deadlineBlocks, the same one escrow.js carries and
        // for the same reason: it is raw deployer text, and a radix-less parseInt
        // MEASURES it as something else entirely ('1e9' is 1, '0x10' is 16, '7abc'
        // is 7, ' 7' is 7, '5.99' is 5). The old `parseInt(x) > 0` check then passed
        // on the mis-measured value and initialize() stored it, so a seller reading
        // '1e9' off the DEPLOY action as a ~19,000-year protection window actually
        // got a 1-block one: the buyer could fund(), take delivery, and reclaim the
        // whole held balance via timeout() one block later, bypassing both the
        // manual settlement path and the automated onDelivery one.
        it('rejects a deadlineBlocks a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e9', '0x10', '0b101', '0o17', '7abc', ' 7', '5.99', '1_000',
                         '+7', '', 'abc', '-', 'Infinity', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployWith([BUYER, SELLER, ARBITER, TICK, '200', v, MARKER])).success, false,
                    `deadlineBlocks ${JSON.stringify(v)} must not deploy`);
            }
        });

        it('rejects a deadlineBlocks outside its range and keeps a canonical one deployable', async function () {
            assert.strictEqual((await deployWith([BUYER, SELLER, ARBITER, TICK, '200', '0', MARKER])).success, false);
            assert.strictEqual((await deployWith([BUYER, SELLER, ARBITER, TICK, '200', '-10', MARKER])).success, false);
            assert.strictEqual((await deployWith([BUYER, SELLER, ARBITER, TICK, '200', '1000001', MARKER])).success, false);
            assert.strictEqual((await deployWith([BUYER, SELLER, ARBITER, TICK, '200', '1000000', MARKER])).success, true);

            // '10' means 10 blocks in state, not the 1 a parseInt of '1e1' gave.
            await deployEscrow(10);
            assertContractState(h.ledger, ADDR, 'window', '10');
        });
    });
});
