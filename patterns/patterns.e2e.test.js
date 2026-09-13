// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Pattern Library
// patterns.e2e.test.js: proves the pattern HELPERS actually run in the VM
// (patterns.test.js only lint/compile-checks them).
//
// Builds a small "vault" contract by concatenating EVERY REAL pattern source
// file (discovered, not listed, so a new pattern cannot ship without compiling
// in the isolate) and exercises onlyOwner / whenNotPaused / requireStatus+setStatus
// / requireAddress / requirePositive / heldBalance through the xchain-vm E2E
// harness (isolated-vm / Node 22).
//
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/patterns/patterns.e2e.test.js

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
} catch (e) { XChainVM = null; console.log('Skipping pattern e2e: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

// Concatenate the actual pattern helpers, then a contract that uses them.
// Discovered by the SAME predicate patterns.test.js and bin/xchain-contracts.js
// listAvailable() use, never enumerated: a literal roster here would let a sixth
// patterns/*.js be listed, scaffolded and linted while never once compiling
// inside the isolate, with every gate green. Sorted for a deterministic blob;
// the pattern files are all top-level function declarations, so concatenation
// order does not affect resolution. test/gate-wiring.test.js asserts, VM-free,
// that those names stay unique and that every file is actually exercised below.
const PATTERN_FILES = fs.readdirSync(__dirname)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'))
    .sort();
assert.ok(PATTERN_FILES.length > 0,
    'no pattern sources discovered in patterns/; the vault would be composed from an ' +
    'empty helper blob and every assertion below would prove nothing');
const HELPERS = PATTERN_FILES
    .map(f => fs.readFileSync(path.join(__dirname, f), 'utf8'))
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

// A tiny contract whose initialize validates one integer param via the REAL
// requireIntInRange helper, so we prove (a) the regex-free helper loads and runs in
// the VM, and (b) it rejects the non-integer shapes a radix-less parseInt would bless.
const INTVALIDATOR = HELPERS + '\n' + `
module.exports = {
    initialize: function (xchain) {
        requireIntInRange(xchain, xchain.getInputParam(0), 1, 1000000, 'deadlineBlocks');
        xchain.state.set('ok', 'true');
    }
};`;

(XChainVM ? describe : describe.skip)('Patterns: requireIntInRange (integer-shape validation)', function () {
    this.timeout(0);
    async function deployWith(param) {
        const b = new E2EHarness(XChainVM);
        b.seedBalance(OWNER, 'XCHAIN', '1000000');
        return b.deploy({ code: INTVALIDATOR, deployer: OWNER, contractAddress: 'C:BTC:7', params: [param] });
    }

    it('accepts a canonical base-10 integer in range', async function () {
        assert.strictEqual((await deployWith('500')).success, true);
    });

    it('rejects non-integer / trailing-garbage / hex / whitespace shapes', async function () {
        for (const bad of ['5.99', '500abc', '0x100', ' 5', '', 'abc', '-']) {
            assert.strictEqual((await deployWith(bad)).success, false, 'should reject ' + JSON.stringify(bad));
        }
    });

    it('rejects an out-of-range integer', async function () {
        assert.strictEqual((await deployWith('0')).success, false);       // below min 1
        assert.strictEqual((await deployWith('2000000')).success, false); // above max 1000000
    });
});

// A tiny contract whose initialize validates one amount param via the REAL
// requirePlainDecimal helper. Same proof as above for the notation gate: the
// regex-free character walk loads and runs inside the VM, and it rejects exactly
// the spellings that requirePositive blesses and floorToDecimals then corrupts.
// requirePositive runs FIRST here, deliberately: the point of the pair is that
// the positivity test alone lets '1.5e-8' and '1.23456789e2' straight through.
const DECIMALVALIDATOR = HELPERS + '\n' + `
module.exports = {
    initialize: function (xchain) {
        var amount = xchain.getInputParam(0);
        requirePositive(xchain, amount, 'amount');
        requirePlainDecimal(xchain, amount, 'amount');
        xchain.state.set('amount', amount);
    }
};`;

(XChainVM ? describe : describe.skip)('Patterns: requirePlainDecimal (notation validation)', function () {
    this.timeout(0);
    let n = 0;
    async function deployWith(param) {
        const b = new E2EHarness(XChainVM);
        b.seedBalance(OWNER, 'XCHAIN', '1000000');
        return b.deploy({ code: DECIMALVALIDATOR, deployer: OWNER, contractAddress: 'C:BTC:' + (100 + n++), params: [param] });
    }

    it('accepts plain fixed-notation decimals', async function () {
        for (const good of ['1', '100', '0.5', '0.00000001', '123456789.123456789']) {
            assert.strictEqual((await deployWith(good)).success, true, 'should accept ' + JSON.stringify(good));
        }
    });

    it('rejects the spellings requirePositive blesses and floorToDecimals corrupts', async function () {
        // Every one of these is > 0 to mathjs, so requirePositive alone passes them.
        for (const bad of ['1.5e-8', '1.23456789e2', '0x10', 'Infinity', '+1', '.5']) {
            assert.strictEqual((await deployWith(bad)).success, false, 'should reject ' + JSON.stringify(bad));
        }
    });

    it('rejects malformed decimals outright', async function () {
        for (const bad of ['5.', '1.2.3', 'abc', '1 ']) {
            assert.strictEqual((await deployWith(bad)).success, false, 'should reject ' + JSON.stringify(bad));
        }
    });

    it('is a NOTATION gate, not a grid check: a legitimately spelled off-grid value passes', async function () {
        // '0.000000015' is plainly spelled and still off an 8-decimal grid. The
        // helper must let it through; the consumer's floorToDecimals is what
        // quantises it. Anything else would make the two checks one, and the
        // grid is unknowable at deploy time.
        assert.strictEqual((await deployWith('0.000000015')).success, true);
    });
});

// The vault above calls one helper from every pattern file, which is the scope
// of the file-granular guard in test/gate-wiring.test.js, and that scope leaves
// seven shipped helpers with lint and compile coverage only, among them the whole
// XChain answer for the AccessControl (onlyRole), SafeERC20 (requireHeld,
// depositedSince) and Enumerable (requireEnum) rows of oz-aliases.json, i.e. the
// first things a Solidity reader pastes. This companion exercises exactly those
// seven on the isolate: isOwner, onlyRole, isPaused, requireHeld, depositedSince,
// requireStatusIn, requireEnum. The guard is now per-HELPER, so a new helper that
// never runs here reddens the gate instead of hiding behind a covered sibling.
const ROLEVAULT = HELPERS + '\n' + `
module.exports = {
    initialize: function (xchain) {
        var owner   = xchain.getInputParam(0);
        var arbiter = xchain.getInputParam(1);
        var tick    = xchain.getInputParam(2);
        var mode    = xchain.getInputParam(3);
        requireAddress(xchain, owner, 'owner');
        requireAddress(xchain, arbiter, 'arbiter');
        requireEnum(xchain, mode, ['STRICT', 'LENIENT'], 'mode');
        xchain.state.set('owner', owner);
        xchain.state.set('arbiter', arbiter);
        xchain.state.set('tick', tick);
        xchain.state.set('mode', mode);
        xchain.state.set('paused', 'false');
        setStatus(xchain, 'OPEN');
        // 'reserve' is deliberately NOT seeded: settle()'s first call is what
        // exercises depositedSince's reserve || '0' default on a null state read.
    },
    // The non-throwing branch forms, recorded so a test can read them back.
    snapshot: function (xchain) {
        xchain.state.set('sawOwner', isOwner(xchain) ? 'true' : 'false');
        xchain.state.set('sawPaused', isPaused(xchain) ? 'true' : 'false');
    },
    pause: function (xchain) { onlyRole(xchain, 'arbiter'); setPaused(xchain, true); },
    mark:  function (xchain) {
        xchain.require(isOwner(xchain), 'owner only');
        xchain.state.set('reserve', heldBalance(xchain, xchain.state.get('tick')));
    },
    hold:  function (xchain) { onlyRole(xchain, 'arbiter'); setStatus(xchain, 'HELD'); },
    settle: function (xchain) {
        onlyRole(xchain, 'arbiter');
        whenNotPaused(xchain);
        requireStatusIn(xchain, ['OPEN', 'HELD']);
        var tick   = xchain.state.get('tick');
        var amount = xchain.getInputParam(0);
        requireHeld(xchain, tick, amount);
        xchain.state.set('fresh', depositedSince(xchain, tick, xchain.state.get('reserve')));
        setStatus(xchain, 'CLOSED');
    }
};`;

const ARBITER = 'arbiter';

(XChainVM ? describe : describe.skip)('Patterns: role vault (the branch-form and multi-state helpers)', function () {
    this.timeout(0);
    let h;

    // `mode` is passed through verbatim, never defaulted with `||`: an empty mode is
    // one of the cases under test, and a falsy default would quietly deploy 'STRICT'
    // instead and turn that assertion into a test of nothing.
    async function deployRoleVault(mode) {
        h = new E2EHarness(XChainVM);
        for (const a of [OWNER, ARBITER, STRANGER]) h.seedBalance(a, 'XCHAIN', '1000000');
        h.seedBalance(OWNER, TICK, '1000');
        return h.deploy({
            code: ROLEVAULT, deployer: OWNER, contractAddress: ADDR,
            params: [OWNER, ARBITER, TICK, mode === undefined ? 'STRICT' : mode]
        });
    }

    it('requireEnum: a mode outside the allowed set is rejected at deploy', async function () {
        assertSuccess(await deployRoleVault('STRICT'));
        assertSuccess(await deployRoleVault('LENIENT'));
        assert.strictEqual((await deployRoleVault('BOGUS')).success, false, 'BOGUS should not deploy');
        assert.strictEqual((await deployRoleVault('')).success, false, 'an empty mode should not deploy');
    });

    it('isOwner / isPaused: the non-throwing forms report the caller and the flag', async function () {
        await deployRoleVault();
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'snapshot', params: [], caller: OWNER }));
        assertContractState(h.ledger, ADDR, 'sawOwner', 'true');
        assertContractState(h.ledger, ADDR, 'sawPaused', 'false');

        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'snapshot', params: [], caller: STRANGER }));
        assertContractState(h.ledger, ADDR, 'sawOwner', 'false');

        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: ARBITER }));
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'snapshot', params: [], caller: OWNER }));
        assertContractState(h.ledger, ADDR, 'sawPaused', 'true');
    });

    it('onlyRole: the role holder passes and the owner does not inherit the role', async function () {
        await deployRoleVault();
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: OWNER }),
            'not authorized (arbiter)');
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: STRANGER }),
            'not authorized (arbiter)');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: ARBITER }));
    });

    it('requireHeld: settling more than the contract holds reverts', async function () {
        await deployRoleVault();
        h.deposit(OWNER, ADDR, TICK, '400');
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'settle', params: ['500'], caller: ARBITER }),
            'insufficient contract balance of ' + TICK);
        assertContractState(h.ledger, ADDR, 'status', 'OPEN');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: ['400'], caller: ARBITER }));
        assertContractState(h.ledger, ADDR, 'status', 'CLOSED');
    });

    it('depositedSince: defaults an unset reserve to 0, then measures growth past a mark', async function () {
        await deployRoleVault();
        h.deposit(OWNER, ADDR, TICK, '500');
        // No reserve has ever been written, so the helper's `reserve || '0'`
        // default is what makes this the full held balance.
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: ['500'], caller: ARBITER }));
        assertContractState(h.ledger, ADDR, 'fresh', '500');

        await deployRoleVault();
        h.deposit(OWNER, ADDR, TICK, '200');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'mark', params: [], caller: OWNER }));
        h.deposit(OWNER, ADDR, TICK, '300');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: ['500'], caller: ARBITER }));
        assertContractState(h.ledger, ADDR, 'fresh', '300');
    });

    it('requireStatusIn: OPEN and HELD both settle, CLOSED does not', async function () {
        await deployRoleVault();
        h.deposit(OWNER, ADDR, TICK, '500');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'hold', params: [], caller: ARBITER }));
        assertContractState(h.ledger, ADDR, 'status', 'HELD');
        assertSuccess(await h.execute({ contractAddress: ADDR, method: 'settle', params: ['500'], caller: ARBITER }));
        assertReverted(await h.execute({ contractAddress: ADDR, method: 'settle', params: ['1'], caller: ARBITER }),
            'CLOSED not in [OPEN, HELD]');
    });
});
