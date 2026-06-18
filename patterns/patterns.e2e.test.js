// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Pattern Library
// patterns.e2e.test.js: proves the pattern HELPERS actually run in the VM
// (patterns.test.js only lint/compile-checks them).
//
// Builds a small "vault" contract by concatenating the REAL pattern source
// files (no copies, so they can't drift) and exercises onlyOwner / whenNotPaused /
// requireStatus+setStatus / requireAddress / requirePositive / heldBalance
// through the xchain-vm E2E harness (isolated-vm / Node 22).
//
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/patterns/patterns.e2e.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM;
try { XChainVM = require(path.join(VM_DIR, 'src', 'index.js')); }
catch (e) { console.log('Skipping pattern e2e: isolated-vm not available (need Node 22)'); }

const { E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js'));
const { assertSuccess, assertReverted, assertEmittedActions,
        assertBalance, assertContractBalance, assertContractState }
        = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js'));

// Concatenate the actual pattern helpers, then a contract that uses them.
const HELPERS = ['access-control', 'pausable', 'safe-transfer', 'validation', 'state-machine']
    .map(n => fs.readFileSync(path.join(__dirname, n + '.js'), 'utf8'))
    .join('\n');

const VAULT = HELPERS + '\n' + `
module.exports = {
    initialize: function (xchain) {
        var owner = xchain.getInputParam(0);
        var tick  = xchain.getInputParam(1);
        requireAddress(xchain, owner, 'owner required');
        requireAddress(xchain, tick, 'tick required');
        xchain.state.set('owner', owner);
        xchain.state.set('tick', tick);
        xchain.state.set('paused', 'false');
        setStatus(xchain, 'OPEN');
    },
    pause:   function (xchain) { onlyOwner(xchain); setPaused(xchain, true);  },
    unpause: function (xchain) { onlyOwner(xchain); setPaused(xchain, false); },
    // Owner sweeps the full held balance to a recipient, once, while OPEN + not paused.
    withdraw: function (xchain) {
        onlyOwner(xchain);
        whenNotPaused(xchain);
        requireStatus(xchain, 'OPEN');
        var to = xchain.getInputParam(0);
        requireAddress(xchain, to, 'recipient required');
        var tick   = xchain.state.get('tick');
        var amount = heldBalance(xchain, tick);
        requirePositive(xchain, amount, 'nothing to withdraw');
        setStatus(xchain, 'CLOSED');   // commit BEFORE emit
        xchain.emit.send({ destination: to, tick: tick, quantity: amount });
    }
};`;

const OWNER = 'owner', STRANGER = 'stranger', RECIPIENT = 'recipient';
const ADDR = 'C:BTC:1', TICK = 'TEST';

(XChainVM ? describe : describe.skip)('Patterns: composed vault (helpers execute)', function () {
    this.timeout(0);
    let h;

    async function deployVault() {
        h = new E2EHarness(XChainVM);
        h.seedBalance(OWNER, 'XCHAIN', '1000000');
        h.seedBalance(STRANGER, 'XCHAIN', '1000000');
        h.seedBalance(OWNER, TICK, '500');
        await h.deploy({ code: VAULT, deployer: OWNER, contractAddress: ADDR, params: [OWNER, TICK] });
    }

    async function fund(amount) {
        h.deposit(OWNER, ADDR, TICK, amount || '500');
    }

    it('happy path: owner withdraws the held balance (safe-transfer + state-machine)', async function () {
        await deployVault();
        await fund('500');
        const r = await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [RECIPIENT], caller: OWNER });
        assertSuccess(r);
        assertEmittedActions(r, [{ action: 'SEND', params: { destination: RECIPIENT, tick: TICK, quantity: '500' } }]);
        assertContractBalance(h.ledger, ADDR, TICK, '0');
        assertBalance(h.ledger, RECIPIENT, TICK, '500');
        assertContractState(h.ledger, ADDR, 'status', 'CLOSED');
    });

    it('onlyOwner: a stranger cannot withdraw', async function () {
        await deployVault();
        await fund('500');
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [STRANGER], caller: STRANGER }),
            'not the owner');
        assertContractBalance(h.ledger, ADDR, TICK, '500'); // untouched
    });

    it('whenNotPaused: paused vault blocks withdraw, unpause restores it', async function () {
        await deployVault();
        await fund('500');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: OWNER }));
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [RECIPIENT], caller: OWNER }),
            'paused');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'unpause', params: [], caller: OWNER }));
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [RECIPIENT], caller: OWNER }));
        assertBalance(h.ledger, RECIPIENT, TICK, '500');
    });

    it('requireStatus: withdraw is once-only (CLOSED blocks a second sweep)', async function () {
        await deployVault();
        await fund('500');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [RECIPIENT], caller: OWNER }));
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [RECIPIENT], caller: OWNER }),
            'invalid state');
    });

    it('requirePositive: withdraw with nothing deposited reverts', async function () {
        await deployVault();
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'withdraw', params: [RECIPIENT], caller: OWNER }),
            'nothing to withdraw');
    });

    it('requireAddress: initialize rejects an empty owner', async function () {
        const bad = new E2EHarness(XChainVM);
        bad.seedBalance(OWNER, 'XCHAIN', '1000000');
        const r = await bad.deploy({ code: VAULT, deployer: OWNER, contractAddress: 'C:BTC:2', params: ['', TICK] });
        assert.strictEqual(r.success, false, 'deploy with empty owner should revert in initialize');
    });
});
