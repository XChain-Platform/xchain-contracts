// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// initialize_once.test.js: a template's constructor runs once
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// EXECUTE dispatches any exported function, initialize included, so a live
// contract must refuse a second initialize itself. Each template is deployed
// through the real VM, then a stranger replays initialize with terms naming
// themselves; the call must revert and leave every state key as it was.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertBalance, assertContractBalance;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertBalance, assertContractBalance }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping initialize-once tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const REPO_DIR = path.join(__dirname, '..');
const ADDR = 'C:BTC:1';
const MALLORY = 'mallory';
const T0 = XChainVM ? new E2EHarness(XChainVM).ledger.blockTimestamp : 0;

// Deploy terms each template accepts, and the replayed terms a stranger would use.
const CASES = [
    { name: 'amm', deployer: 'lp1', params: ['AAA', 'BBB', 'AAABBBLP'], replay: ['AAA', 'BBB', 'MALLORYLP'] },
    { name: 'cardDispenser', deployer: 'owner', decimals: ['PAY', 'CA', 'CB'],
      params: ['PAY', '2.5', '1', 'CA', 'CB'], replay: ['PAY', '0.00000001', '1', 'CA', 'CB'] },
    { name: 'counterpartyBridge', deployer: 'holder', decimals: ['BRIDGEDCARD'],
      params: ['XCPCARD', 'BRIDGEDCARD', '1000000', '8'], replay: ['XCPCARD', 'MALLORYCARD', '1000000', '8'] },
    { name: 'crowdsale', deployer: 'owner', params: ['owner', 'PAY', 'SALE', '10', '100', '200', '50', '8'],
      replay: [MALLORY, 'PAY', 'MSALE', '10', '1', '200', '50', '8'] },
    { name: 'dutchAuction', deployer: 'seller', params: ['seller', 'ITEM', '10', 'TEST', '1000', '100', '10'],
      replay: [MALLORY, 'ITEM', '10', 'TEST', '1000', '100', '10'] },
    { name: 'englishAuction', deployer: 'seller', params: ['seller', 'ITEM', '10', 'TEST', '50', '5'],
      replay: [MALLORY, 'ITEM', '10', 'TEST', '50', '5'] },
    { name: 'escrow', deployer: 'buyer', params: ['buyer', 'seller', 'arbiter', 'TEST', '200', '3'],
      replay: [MALLORY, MALLORY, MALLORY, 'TEST', '1', '1'] },
    { name: 'escrowDelivery', deployer: 'buyer',
      params: ['buyer', 'seller', 'arbiter', 'TEST', '200', '3', '"status":"delivered"', 'https://carrier.example.com/track/1'],
      replay: [MALLORY, MALLORY, MALLORY, 'TEST', '1', '1', '"status":"delivered"', 'https://carrier.example.com/track/1'] },
    { name: 'priceBet', deployer: 'maker', decimals: ['TEST'],
      params: ['maker', 'BTC/USD', '60000', 'OVER', 'TEST', '100', '7', '5'],
      replay: [MALLORY, 'BTC/USD', '60000', 'OVER', 'TEST', '100', '7', '5'] },
    { name: 'priceBetTimed', deployer: 'maker', decimals: ['TEST'],
      params: ['maker', 'BTC/USD', '60000', 'OVER', 'TEST', '100', String(T0 + 1500), '5'],
      replay: [MALLORY, 'BTC/USD', '60000', 'OVER', 'TEST', '100', String(T0 + 1500), '5'] },
    { name: 'stableVault', deployer: 'alice', decimals: ['GOLD', 'DUSD'],
      params: ['GOLD', 'DUSD', 'GOLD/USD', '150', '10', '10', '8'], replay: ['GOLD', 'MUSD', 'GOLD/USD', '101', '10', '10', '8'] },
    { name: 'treasury', deployer: 'guardian', params: ['guardian', 'GOV', '10', '20', '100', 'guardian'],
      replay: [MALLORY, 'MGOV', '1', '1', '1', 'open'] },
    { name: 'vesting', deployer: 'grantor', decimals: ['TEST'], params: ['grantor', 'beneficiary', 'TEST', '1000', '10', '100', 'false'],
      replay: [MALLORY, MALLORY, 'TEST', '1', '0', '1', 'false'] }
];

function codeOf(name) {
    return fs.readFileSync(path.join(REPO_DIR, name, name + '.js'), 'utf8');
}

async function deployCase(c) {
    const h = new E2EHarness(XChainVM);
    h.seedBalance(c.deployer, 'XCHAIN', '1000000');
    for (const tick of c.decimals || []) h.ledger.setTokenDecimals(tick, 8);
    const r = await h.deploy({ code: codeOf(c.name), deployer: c.deployer, contractAddress: ADDR, params: c.params });
    assertSuccess(r, c.name + ' must deploy with the fixture terms');
    return h;
}

function snapshot(h) {
    return JSON.stringify(h.ledger.getContractState(ADDR));
}

// Every <name>/<name>.js that exports initialize, so a new template cannot skip the table.
function templatesWithInitialize() {
    return fs.readdirSync(REPO_DIR).filter(function (name) {
        const file = path.join(REPO_DIR, name, name + '.js');
        if (!fs.existsSync(file)) return false;
        const mod = require(file);
        return Boolean(mod) && typeof mod.initialize === 'function';
    }).sort();
}

function registerReplayCases() {
    it('the table covers every template that exports initialize', function () {
        const found = templatesWithInitialize();
        assert.ok(found.length >= 13, 'discovery found only ' + found.length + ' templates');
        assert.deepStrictEqual(CASES.map(c => c.name).sort(), found);
    });

    for (const c of CASES) {
        it(c.name + ': a second initialize from a stranger reverts and changes no state', async function () {
            const h = await deployCase(c);
            const before = snapshot(h);
            const r = await h.execute({ contractAddress: ADDR, method: 'initialize', params: c.replay, caller: MALLORY });
            assertReverted(r, 'already initialized');
            assert.strictEqual(snapshot(h), before, c.name + ': a refused initialize must leave state untouched');
        });
    }
}

// The custody path the guard exists for: re-initialize, then drain through cancel().
function registerCustodyCases() {
    it('escrow: a funded escrow cannot be re-initialized and cancelled by a stranger', async function () {
        const c = CASES.find(x => x.name === 'escrow');
        const h = await deployCase(c);
        h.seedBalance('buyer', 'TEST', '200');
        h.deposit('buyer', ADDR, 'TEST', '200');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: 'buyer' }));
        await h.execute({ contractAddress: ADDR, method: 'initialize', params: c.replay, caller: MALLORY });
        await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MALLORY });
        assertBalance(h.ledger, MALLORY, 'TEST', '0');
        assertContractBalance(h.ledger, ADDR, 'TEST', '200');
    });

    it('vesting: a funded grant cannot be re-initialized and cancelled by a stranger', async function () {
        const c = CASES.find(x => x.name === 'vesting');
        const h = await deployCase(c);
        h.seedBalance('grantor', 'TEST', '1000');
        h.deposit('grantor', ADDR, 'TEST', '1000');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: 'grantor' }));
        await h.execute({ contractAddress: ADDR, method: 'initialize', params: c.replay, caller: MALLORY });
        await h.execute({ contractAddress: ADDR, method: 'cancel', params: [], caller: MALLORY });
        assertBalance(h.ledger, MALLORY, 'TEST', '0');
        assertContractBalance(h.ledger, ADDR, 'TEST', '1000');
    });
}

(XChainVM ? describe : describe.skip)('templates: initialize runs once', function () {
    describe('a replayed initialize is refused', registerReplayCases);
    describe('custody cannot be taken over through initialize', registerCustodyCases);
});
