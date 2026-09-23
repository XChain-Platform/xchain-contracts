// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// poll-callback-wiring.test.js: treasury.arm's arity is the indexer's poll wire.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// arm() is fired by the indexer's binding-poll finalization, not by a user, and it
// reverts on any argument count but the one it pins. The wire it receives is built
// in xchain-indexer/src/actions/vote/binding_callback.js, which exports its slot
// declaration (POLL_CALLBACK_FIXED_SLOTS, POLL_CALLBACK_TICK_SLOT) and pins the
// builder to it in its own suite. This file pins arm() to that declaration, so an
// indexer-side slot change goes red here instead of leaving every deployed
// treasury unable to arm after the poll and its GAS_ESCROW are already spent.
//
// The indexer checkout is a REQUIRED sibling (.ci-siblings, ci.yml): when it is
// absent this file fails, it never skips.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/poll-callback-wiring.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_DIR      = path.join(__dirname, '..');
const TREASURY_FILE = path.join(REPO_DIR, 'treasury', 'treasury.js');
const BUILDER_FILE  = path.join(REPO_DIR, '..', 'xchain-indexer', 'src', 'actions', 'vote', 'binding_callback.js');

// The CALLBACK_PARAMS treasury/README.md tells a deployer to set on the binding poll.
const TREASURY_CALLBACK_PARAMS = ['proposalId'];

// Load the indexer's declared poll wire, failing (never skipping) when it cannot be read.
function loadPollWire() {
    if (!fs.existsSync(BUILDER_FILE)) {
        assert.fail('xchain-indexer is not checked out beside this repo (looked for ' + BUILDER_FILE + '). ' +
                    'It is a required sibling: clone it there, or on CI declare it in .ci-siblings and ' +
                    'check it out in .github/workflows/ci.yml.');
    }
    let builder;
    try { builder = require(BUILDER_FILE); }
    catch (err) { assert.fail('could not load ' + BUILDER_FILE + ': ' + err.message); }
    const fixed = builder.POLL_CALLBACK_FIXED_SLOTS;
    const tick  = builder.POLL_CALLBACK_TICK_SLOT;
    if (!Array.isArray(fixed) || fixed.length === 0 || typeof tick !== 'string' || tick === '') {
        assert.fail('binding_callback.js no longer exports POLL_CALLBACK_FIXED_SLOTS / POLL_CALLBACK_TICK_SLOT, ' +
                    'so arm()\'s arity is pinned to nothing. Restore the declaration rather than hardcoding a count here.');
    }
    return { fixed: fixed.slice(), tick: tick };
}

// The wire arm() receives on a post-flag-day poll bound with the treasury's CALLBACK_PARAMS.
function expectedArmWire(wire) {
    return wire.fixed.concat([wire.tick], TREASURY_CALLBACK_PARAMS);
}

// Every integer arm() compares getInputParamCount() against, read from its own source.
function pinnedArities(armFn) {
    const src = String(armFn);
    const re  = /getInputParamCount\s*\(\s*\)\s*===\s*(\d+)/g;
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) out.push(Number(m[1]));
    return out;
}

const MOVE_TOGETHER = 'The indexer\'s poll callback wire moved: treasury.js\'s getInputParamCount() pin, its ' +
                      'abi.methods.arm params, and the CALLBACK_PARAMS guidance in treasury/README.md must move with it.';

describe('poll finalization callbacks: treasury.arm is pinned to the indexer\'s wire', function () {

    it('the indexer declares the poll wire this file checks against', function () {
        const wire = loadPollWire();
        assert.ok(wire.fixed.every(s => typeof s === 'string' && s !== ''),
            'POLL_CALLBACK_FIXED_SLOTS holds a non-string slot: ' + JSON.stringify(wire.fixed));
    });

    it('arm() pins exactly the arity the indexer sends', function () {
        const expected = expectedArmWire(loadPollWire()).length;
        const pins     = pinnedArities(require(TREASURY_FILE).arm);
        assert.strictEqual(pins.length, 1,
            'expected one getInputParamCount() === N pin in treasury.arm, found ' + pins.length +
            ' (' + pins.join(', ') + '); the arity check cannot be read, so it is certified against nothing');
        assert.strictEqual(pins[0], expected,
            'treasury.arm pins ' + pins[0] + ' arguments; the indexer sends ' + expected + '. ' + MOVE_TOGETHER);
    });

    it('arm\'s abi declares the full wire, slot for slot in indexer order', function () {
        const expected = expectedArmWire(loadPollWire());
        const spec     = ((require(TREASURY_FILE).abi || {}).methods || {}).arm;
        assert.ok(spec && Array.isArray(spec.params), 'treasury has no abi.methods.arm params array');
        assert.deepStrictEqual(spec.params.map(p => p && p.name), expected,
            'abi.methods.arm.params does not name the wire the indexer sends. ' + MOVE_TOGETHER);
    });
});
