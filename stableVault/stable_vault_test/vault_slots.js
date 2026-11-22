// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// stable_vault_test/vault_slots.js: bounded vault-key growth and refund tests
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { available, Harness, STATE_LIMITS } = require('../../test/helpers/harness.js');

const CODE = fs.readFileSync(path.join(__dirname, '..', 'stableVault.js'), 'utf8');
const ADDR = 'C:BTC:1';
const COLL = 'GOLD';
const STABLE = 'DUSD';
const ACTORS = ['alice', 'bob', 'carol', 'liq'];

function withCeiling(n) {
    const anchor = 'var MAX_VAULTS = 4900;';
    assert.strictEqual(CODE.split(anchor).length, 2, 'MAX_VAULTS anchor changed');
    return CODE.replace(anchor, 'var MAX_VAULTS = ' + n + ';');
}

function setup(code, maxStateKeys) {
    const h = new Harness({ limits: { maxStateKeys: maxStateKeys || STATE_LIMITS.maxStateKeys } });
    h.ledger.setTokenDecimals(COLL, 8);
    for (const who of ACTORS) h.seedBalance(who, COLL, '1000');
    const deployed = h.deploy({ code: code, deployer: 'alice', contractAddress: ADDR,
        params: [COLL, STABLE, 'GOLD/USD', '150', '10', '10', '8'] });
    assert.ok(deployed.success, deployed.error);
    h.ledger.oracle.prices['GOLD/USD'] = { price: '100', roundNumber: 1, timestamp: h.ledger.blockTimestamp };
    return h;
}

function call(h, who, method, params) {
    return h.execute({ contractAddress: ADDR, method: method, params: params || [], caller: who });
}

function deposit(h, who, amount) {
    h.deposit(who, ADDR, COLL, amount);
    return call(h, who, 'deposit');
}

(available ? describe : describe.skip)('stableVault vault state-key ceiling', function () {
    it('refunds a newcomer at the ceiling and reserves debt keys for admitted vaults', function () {
        const h = setup(withCeiling(2), 15);
        assert.ok(deposit(h, 'alice', '10').success);
        assert.ok(deposit(h, 'bob', '10').success);
        const refused = deposit(h, 'carol', '10');
        assert.ok(refused.success, refused.error);
        assert.deepStrictEqual(refused.actions.map((a) => [a.action, a.params.destination, a.params.quantity]),
            [['SEND', 'carol', '10']]);
        assert.strictEqual(h.state(ADDR, 'v:carol:coll'), null);
        assert.strictEqual(h.state(ADDR, 'trackedColl'), '20');
        assert.strictEqual(h.state(ADDR, 'vaults'), '2');
        assert.ok(deposit(h, 'alice', '5').success);
        assert.strictEqual(h.state(ADDR, 'v:alice:coll'), '15');
        assert.ok(call(h, 'alice', 'borrow', ['1']).success);
        assert.ok(call(h, 'bob', 'borrow', ['1']).success);
    });

    it('deletes empty vault keys, frees a slot, and creates no zero-debt key', function () {
        const h = setup(withCeiling(2), 15);
        assert.ok(deposit(h, 'alice', '10').success);
        assert.ok(deposit(h, 'bob', '10').success);
        assert.ok(call(h, 'alice', 'borrow', ['1']).success);
        h.deposit('alice', ADDR, STABLE, '1');
        assert.ok(call(h, 'alice', 'repay').success);
        assert.ok(call(h, 'alice', 'withdraw', ['10']).success);
        assert.strictEqual(h.state(ADDR, 'v:alice:debt'), null);
        assert.strictEqual(h.state(ADDR, 'v:alice:coll'), null);
        assert.strictEqual(h.state(ADDR, 'vaults'), '1');
        assert.ok(deposit(h, 'carol', '10').success);
        h.seedBalance('liq', STABLE, '1');
        h.deposit('liq', ADDR, STABLE, '1');
        assert.ok(call(h, 'liq', 'repay').success);
        assert.strictEqual(h.state(ADDR, 'v:liq:debt'), null);
    });

    it('demonstrates the unbounded control and keeps the shipped budget below the VM cap', function () {
        const h = setup(withCeiling(1000000), 13);
        assert.ok(deposit(h, 'alice', '10').success);
        assert.ok(deposit(h, 'bob', '10').success);
        const stranded = deposit(h, 'carol', '10');
        assert.ok(!stranded.success && /max state keys/.test(stranded.error), stranded.error);
        assert.ok(call(h, 'alice', 'deposit').success);
        assert.strictEqual(h.state(ADDR, 'v:alice:coll'), '20');
        const normal = setup(CODE);
        const info = JSON.parse(call(normal, 'alice', 'info').result);
        assert.strictEqual(info.vaults, '0');
        assert.strictEqual(info.maxVaults, '4900');
        assert.ok(Object.keys(normal.ledger.state[ADDR]).length + 2 * 4900 < STATE_LIMITS.maxStateKeys);
    });
});
