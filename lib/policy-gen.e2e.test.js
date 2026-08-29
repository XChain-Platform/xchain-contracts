// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// policy-gen.e2e.test.js: the generated guards cross the REAL deploy gate.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Why this file exists
// --------------------
// lib/policy-gen.js is the one DEPLOYABLE output this library ships that nobody
// hand-wrote: `xchain-contracts policy` prints it and users deploy it verbatim.
// Its sibling in lib/policy-gen.test.js checks the generated source two ways,
// and neither is the deploy gate:
//   - lintSource() from xchain-vm/src/lint-core.js is acorn-only. Its own header
//     says it carries every deploy-time check EXCEPT the V8 syntax compile.
//   - loadContract() runs the guard under `new Function` against a mock xchain,
//     so it uses Node's parser and Node's globals, not the isolate and not the
//     stripped sandbox.
// The real gate is vm.validateSyntax(code) (xchain-vm/src/syntax.js): a V8
// compileScriptSync FIRST, then the acorn rules. A construct acorn accepts and
// V8 rejects, or a guard that leaned on a global sandbox.js strips, would keep
// that suite green while a live deploy or execute rejected it.
//
// Every hand-written template already crosses the gate through
// E2EHarness.deploy() (urlOracle/urlOracle.test.js, patterns/patterns.e2e.test.js);
// this file gives the generated guards the same treatment: deploy each config in
// the shared matrix, execute representative guard and admin behaviour on the
// isolate, and hold a live-gate negative control so a gate that stopped running
// cannot be mistaken for a gate that passed.
//
// Needs Node 22 and a built isolated-vm, like every other e2e suite here; it
// degrades to describe.skip elsewhere, and test/preflight.test.js is what turns
// that skip red on a venue that is supposed to have the harness.
//
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/lib/policy-gen.e2e.test.js

'use strict';

const assert = require('assert');
const path = require('path');
const { generatePolicy } = require('./policy-gen.js');
const { OWNER, NOTOWNER, MATRIX } = require('../test/policy-matrix.js');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
} catch (e) {
    XChainVM = null;
    console.log('Skipping policy-gen e2e: xchain-vm harness not available (need Node 22 + built isolated-vm):', e.message);
}

// Fresh ledger per case so one guard's state can never explain another's verdict.
function harnessFor() {
    const h = new E2EHarness(XChainVM);
    h.seedBalance(OWNER, 'XCHAIN', '1000000');
    h.seedBalance(NOTOWNER, 'XCHAIN', '1000000');
    h.seedBalance('1Caller', 'XCHAIN', '1000000');
    return h;
}

// Deploy a generated guard through vm.validateSyntax + real-sandbox initialize.
async function deployPolicy(h, cfg, addr) {
    const { source } = generatePolicy(cfg);
    const d = await h.deploy({ code: source, deployer: OWNER, contractAddress: addr });
    return { source, deployed: d };
}

function guardResult(r) {
    assert.strictEqual(r.success, true, 'guard should allow: ' + r.error);
    return JSON.parse(r.returnValue);
}

(XChainVM ? describe : describe.skip)('policy-gen: generated guards pass the real deploy gate', function () {
    this.timeout(0);

    let n = 0;
    for (const key of Object.keys(MATRIX)) {
        it(key + ' deploys through E2EHarness.deploy() (V8 compile + acorn rules + init)', async function () {
            const addr = 'C:BTC:PG' + (++n);
            const { deployed } = await deployPolicy(harnessFor(), MATRIX[key], addr);
            assert.strictEqual(deployed.success, true, key + ' should deploy: ' + deployed.error);
        });
    }

    // Negative control. Without it every case above is satisfied by a gate that
    // never ran, which is the exact failure this file exists to catch. Mutating
    // the GENERATED source (not a hand-written fixture) keeps the control on the
    // same code path the positive cases use.
    it('the gate is live: an async surface spliced into a generated guard is rejected', async function () {
        const { source } = generatePolicy(MATRIX.pauseOnly);
        const banned = source.replace('    guard: function (xchain) {',
                                      '    guard: async function (xchain) {');
        assert.notStrictEqual(banned, source, 'the mutation must actually apply');
        const d = await harnessFor().deploy({ code: banned, deployer: OWNER, contractAddress: 'C:BTC:PGBAD' });
        assert.strictEqual(d.success, false, 'the deploy gate must reject an async surface');
        assert.match(String(d.error), /banned async surface/);
    });
});

(XChainVM ? describe : describe.skip)('policy-gen: generated guards enforce on the real VM', function () {
    this.timeout(0);

    it('royalty: a trade action returns payoutLegs, a transfer returns {}', async function () {
        const h = harnessFor();
        const ADDR = 'C:BTC:PGROY';
        assert.strictEqual((await deployPolicy(h, MATRIX.royaltyOnly, ADDR)).deployed.success, true);

        const trade = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['ORDER_CREATE', '1Maker', '1Taker'], caller: '1Caller' });
        assert.deepStrictEqual(guardResult(trade), { payoutLegs: [{ to: '1Creator', bps: 500 }] });

        const send = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Maker', '1Taker'], caller: '1Caller' });
        assert.deepStrictEqual(guardResult(send), {});
    });

    it('pausable: initialize seeds state, owner-only pause blocks the guard, unpause restores it', async function () {
        const h = harnessFor();
        const ADDR = 'C:BTC:PGPAUSE';
        assert.strictEqual((await deployPolicy(h, MATRIX.pauseOnly, ADDR)).deployed.success, true);
        // initialize ran inside the isolate, not in a mock.
        assert.strictEqual(h.ledger.getContractState(ADDR).paused, 'false');

        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1a', '1b'], caller: '1Caller' })), {});

        const stranger = await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: NOTOWNER });
        assert.strictEqual(stranger.success, false, 'a non-owner must not pause');
        assert.match(String(stranger.error), /not owner/);

        assert.strictEqual((await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: OWNER })).success, true);
        const blocked = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1a', '1b'], caller: '1Caller' });
        assert.strictEqual(blocked.success, false, 'a paused guard must revert');
        assert.match(String(blocked.error), /paused/);

        assert.strictEqual((await h.execute({ contractAddress: ADDR, method: 'unpause', params: [], caller: OWNER })).success, true);
        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1a', '1b'], caller: '1Caller' })), {});
    });

    it('freeze: seeded frozen accounts block as sender or recipient; runtime freeze takes effect', async function () {
        const h = harnessFor();
        const ADDR = 'C:BTC:PGFREEZE';
        assert.strictEqual((await deployPolicy(h, MATRIX.freezeOnly, ADDR)).deployed.success, true);
        assert.strictEqual(h.ledger.getContractState(ADDR)['frozen:1Frozen'], 'true');

        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Clean', '1AlsoClean'], caller: '1Caller' })), {});

        const fromFrozen = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Frozen', '1Clean'], caller: '1Caller' });
        assert.strictEqual(fromFrozen.success, false);
        assert.match(String(fromFrozen.error), /account frozen/);

        const toFrozen = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Clean', '1Frozen'], caller: '1Caller' });
        assert.strictEqual(toFrozen.success, false);
        assert.match(String(toFrozen.error), /account frozen/);

        assert.strictEqual((await h.execute({ contractAddress: ADDR, method: 'freeze', params: ['1NewBad'], caller: OWNER })).success, true);
        const nowFrozen = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1NewBad', '1Clean'], caller: '1Caller' });
        assert.strictEqual(nowFrozen.success, false);
        assert.match(String(nowFrozen.error), /account frozen/);
    });

    it('allowlist: a non-allowlisted sender is blocked until the owner allows it', async function () {
        const h = harnessFor();
        const ADDR = 'C:BTC:PGALLOW';
        assert.strictEqual((await deployPolicy(h, MATRIX.allowOnly, ADDR)).deployed.success, true);

        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Good', '1Anyone'], caller: '1Caller' })), {});

        const stranger = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Stranger', '1Anyone'], caller: '1Caller' });
        assert.strictEqual(stranger.success, false);
        assert.match(String(stranger.error), /not allowlisted/);

        assert.strictEqual((await h.execute({ contractAddress: ADDR, method: 'allow', params: ['1Stranger'], caller: OWNER })).success, true);
        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Stranger', '1Anyone'], caller: '1Caller' })), {});
    });

    it('allowlist "both": the recipient is checked on the isolate, and an empty recipient is exempt', async function () {
        const h = harnessFor();
        const ADDR = 'C:BTC:PGALLOWBOTH';
        assert.strictEqual((await deployPolicy(h, MATRIX.allowBoth, ADDR)).deployed.success, true);

        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Good', '1AlsoGood'], caller: '1Caller' })), {});

        // The gap this direction closes: an allowlisted holder moving to a stranger.
        const toStranger = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Good', '1Stranger'], caller: '1Caller' });
        assert.strictEqual(toStranger.success, false);
        assert.match(String(toStranger.error), /not allowlisted/);

        // The empty-recipient exemption, on the real isolate: the indexer passes '' for
        // burns and for every escrow-creating action, so these must still clear.
        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['DESTROY', '1Good', ''], caller: '1Caller' })), {});
        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['ORDER_CREATE', '1Good', ''], caller: '1Caller' })), {});

        assert.strictEqual((await h.execute({ contractAddress: ADDR, method: 'allow', params: ['1Stranger'], caller: OWNER })).success, true);
        assert.deepStrictEqual(guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['SEND', '1Good', '1Stranger'], caller: '1Caller' })), {});
    });

    it('full policy: the whole stack composes, and the pause gate still wins over a clean trade', async function () {
        const h = harnessFor();
        const ADDR = 'C:BTC:PGFULL';
        assert.strictEqual((await deployPolicy(h, MATRIX.full, ADDR)).deployed.success, true);

        // Allowlisted, unfrozen sender on a trade action -> the royalty legs.
        assert.deepStrictEqual(
            guardResult(await h.execute({ contractAddress: ADDR, method: 'guard', params: ['ORDER_CREATE', '1Good', '1Buyer'], caller: '1Caller' })),
            { payoutLegs: [{ to: '1Creator', bps: 250 }, { to: '1Market', bps: 100 }] }
        );

        assert.strictEqual((await h.execute({ contractAddress: ADDR, method: 'pause', params: [], caller: OWNER })).success, true);
        const paused = await h.execute({ contractAddress: ADDR, method: 'guard', params: ['ORDER_CREATE', '1Good', '1Buyer'], caller: '1Caller' });
        assert.strictEqual(paused.success, false, 'pause must beat an otherwise-clean trade');
        assert.match(String(paused.error), /paused/);
    });
});
