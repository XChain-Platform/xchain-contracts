// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// urlOracle_test/invariants.js: seeded invariant tests for urlOracle.js on the in-process harness
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The shared harness does not model the attestation framework, so this file
// wraps it (AttestHarness below): attestation.request records an ATTEST action
// and returns a deterministic 64-hex id derived from the contract address and a
// per-harness counter, attestation.getResponse reads responses the test seeds,
// and ATTEST actions are left out of ledger settlement. Request ids in the real
// VM come from the VM's own derivation; nothing here depends on their value.

'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { available, Harness, rng } = require('../../test/inproc/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'urlOracle.js'), 'utf8');
const ADDR = 'C:BTC:1';
const URL = 'https://api.example.com/btc/price';

class AttestHarness extends Harness {
    constructor() { super(); this.responses = {}; this.requestSeq = 0; this.requests = []; }
    seedAttestation(id, resp) { this.responses[id] = resp; }
    makeApi(addr, params, caller, actions) {
        const api = super.makeApi(addr, params, caller, actions);
        const self = this;
        api.attestation = {
            request: function (providerId, payload, callbackMethod, callbackParams, opts) {
                self.requestSeq += 1;
                const id = crypto.createHash('sha256').update(addr + ':' + self.requestSeq).digest('hex');
                actions.push({ action: 'ATTEST', params: JSON.parse(JSON.stringify({ providerId: providerId,
                    requestPayload: payload, callbackMethod: callbackMethod, callbackParams: callbackParams,
                    options: opts, requestId: id })) });
                return id;
            },
            getResponse: function (id) {
                return self.responses[id] === undefined ? null : JSON.parse(JSON.stringify(self.responses[id]));
            }
        };
        api.log = function () { self.log.push(Array.prototype.join.call(arguments, ' ')); };
        return api;
    }
    applyActions(addr, actions) {
        super.applyActions(addr, actions.filter((a) => a.action !== 'ATTEST'));
    }
}

function setup() {
    const h = new AttestHarness();
    h.seedBalance('addr1', 'XCP', '10');
    const r = h.deploy({ code: CODE, deployer: 'addr1', contractAddress: ADDR });
    assert.ok(r.success, r.error);
    return h;
}

function call(h, method, params, caller) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: caller || 'addr1' });
}

(available ? describe : describe.skip)('urlOracle invariants (in-process)', function () {

    it('price only ever holds a settled ok payload; nothing moves tokens; seeded call sequences', function () {
        const CALLERS = ['addr1', 'addr2', 'stranger'];
        for (let seed = 1; seed <= 150; seed++) {
            const R = rng(seed);
            const h = setup();
            h.deposit('addr1', ADDR, 'XCP', '1');
            const ids = [];
            const okPayloads = new Set();
            let lastRequested = null;
            for (let step = 0; step < 30; step++) {
                const roll = R.next();
                let r;
                if (roll < 0.35) {
                    r = call(h, 'requestPrice', [R.next() < 0.1 ? '' : URL + '?' + step], R.pick(CALLERS));
                    if (r.success) {
                        assert.strictEqual(r.actions.length, 1);
                        assert.strictEqual(r.actions[0].action, 'ATTEST');
                        assert.strictEqual(r.actions[0].params.callbackMethod, 'onPrice');
                        assert.strictEqual(h.state(ADDR, 'pending'), r.result);
                        ids.push(r.result);
                        lastRequested = r.result;
                    }
                } else if (roll < 0.6 && ids.length) {
                    const id = R.pick(ids);
                    const ok = R.next() < 0.7;
                    const payload = ok ? String(R.int(1, 99999)) + '.' + String(R.int(0, 99)) : '';
                    h.seedAttestation(id, { status: ok ? 'ok' : R.pick(['failed', 'disputed']), payload: payload, providerId: 'http_get' });
                    if (ok) okPayloads.add(payload);
                } else {
                    const id = ids.length && R.next() < 0.9 ? R.pick(ids) : 'f'.repeat(64);
                    const priceBefore = h.state(ADDR, 'price');
                    const pendingBefore = h.state(ADDR, 'pending');
                    r = call(h, 'onPrice', [id, 'http_get', 'ok', ''], R.pick(CALLERS));
                    const resp = h.responses[id];
                    if (!resp) {
                        assert.ok(!r.success, 'seed ' + seed + ': unsettled id committed');
                        assert.match(r.error, /no response yet/);
                    } else if (resp.status !== 'ok') {
                        assert.ok(!r.success, 'seed ' + seed + ': failed attestation committed');
                    } else {
                        assert.ok(r.success, r.error);
                        assert.strictEqual(h.state(ADDR, 'price'), resp.payload);
                        assert.strictEqual(h.state(ADDR, 'pending'), null);
                    }
                    if (!r.success) {
                        assert.strictEqual(h.state(ADDR, 'price'), priceBefore, 'a revert changed price');
                        assert.strictEqual(h.state(ADDR, 'pending'), pendingBefore, 'a revert changed pending');
                    }
                }
                if (r) assert.ok(r.actions.every((a) => a.action === 'ATTEST'), 'seed ' + seed + ': token action emitted');
                const price = h.state(ADDR, 'price');
                assert.ok(price === null || okPayloads.has(price), 'seed ' + seed + ': price ' + price + ' was never a settled ok body');
                const pending = h.state(ADDR, 'pending');
                assert.ok(pending === null || pending === lastRequested, 'seed ' + seed + ': pending is not the latest request');
                assert.strictEqual(h.ledger.total('XCP'), '10');
                assert.strictEqual(h.ledger.getBalance(ADDR, 'XCP'), '1', 'custody moved');
            }
        }
    });

    it('request ids are distinct per request and requestPrice rejects an empty or missing url', function () {
        const h = setup();
        const a = call(h, 'requestPrice', [URL]);
        const b = call(h, 'requestPrice', [URL]);
        assert.ok(a.success && b.success);
        assert.notStrictEqual(a.result, b.result);
        assert.match(call(h, 'requestPrice', []).error, /url required/);
        assert.match(call(h, 'requestPrice', ['']).error, /url required/);
        assert.match(call(h, 'requestPrice', [{ toString: () => URL }]).error, /url required/);
    });

    it('a failed attestation reverts and leaves pending set for a later request', function () {
        const h = setup();
        const id = call(h, 'requestPrice', [URL]).result;
        h.seedAttestation(id, { status: 'failed', payload: '', providerId: 'http_get' });
        assert.match(call(h, 'onPrice', [id]).error, /attestation failed: failed/);
        assert.strictEqual(h.state(ADDR, 'pending'), id);
        assert.strictEqual(h.state(ADDR, 'price'), null);
    });

    // KNOWN LIMITATION (documented in urlOracle.js and README): onPrice is not pinned
    // to the pending request. This pins the documented behaviour so a change to it is visible.
    it('documented limitation: an older settled response replays over a newer price and clears pending', function () {
        const h = setup();
        const old = call(h, 'requestPrice', [URL]).result;
        h.seedAttestation(old, { status: 'ok', payload: '100', providerId: 'http_get' });
        assert.ok(call(h, 'onPrice', [old]).success);
        const fresh = call(h, 'requestPrice', [URL]).result;
        h.seedAttestation(fresh, { status: 'ok', payload: '200', providerId: 'http_get' });
        assert.ok(call(h, 'onPrice', [fresh]).success);
        const third = call(h, 'requestPrice', [URL], 'stranger').result;
        assert.strictEqual(h.state(ADDR, 'pending'), third);
        const replay = call(h, 'onPrice', [old], 'stranger');
        assert.ok(replay.success, replay.error);
        assert.strictEqual(h.state(ADDR, 'price'), '100');
        assert.strictEqual(h.state(ADDR, 'pending'), null);
    });

    it('determinism: the same seeded sequence yields byte-identical state', function () {
        function runOnce() {
            const R = rng(11);
            const h = setup();
            const ids = [];
            for (let i = 0; i < 25; i++) {
                if (R.next() < 0.5) ids.push(call(h, 'requestPrice', [URL]).result);
                else if (ids.length) {
                    const id = R.pick(ids);
                    h.seedAttestation(id, { status: 'ok', payload: String(i), providerId: 'http_get' });
                    call(h, 'onPrice', [id]);
                }
            }
            return JSON.stringify(h.ledger.snapshot()) + h.log.join('|');
        }
        assert.strictEqual(runOnce(), runOnce());
    });
});
