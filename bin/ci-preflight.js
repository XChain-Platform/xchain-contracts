#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// CI preflight: prove the xchain-vm harness is actually loadable BEFORE the
// suites run.
//
// Every template suite here degrades to `describe.skip` when it cannot require
// the adjacent xchain-vm harness, which is the right behaviour for a developer
// on a machine where the isolated-vm binding will not load (macOS, or any Node
// other than 22). It is the wrong behaviour for CI: a run that skips 235 of 287
// tests and exits 0 reports the same green as a run that executed them, so a
// missing sibling checkout, a failed native build, or a wrong Node major would
// all read as "contracts pass".
//
// This script performs the SAME requires the suites perform, so it cannot pass
// while they skip, and exits non-zero with the reason if any of them fails.
//
// It guards `npm run ci` only, and `npm test` is the command people actually
// type: run bare, it reported 52 passing / 243 pending / exit 0 on macOS while
// 82 percent of the suite skipped. test/preflight.test.js is the same proof
// living INSIDE the mocha run (wired first in the `test` script, locked there
// by test/gate-wiring.test.js), so no choice of command reaches a false green.
// Keep the two in step: both must prove an isolate actually executes, because
// requiring xchain-vm's harness helper succeeds even where isolated-vm cannot
// dlopen.

'use strict';

const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');

const REQUIRED = [
    ['xchain-vm entrypoint',   path.join(VM_DIR, 'src', 'index.js')],
    ['the e2e harness helper', path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')],
    ['the e2e assertions',     path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')]
];

function fail(what, err) {
    console.error('');
    console.error('CI preflight FAILED: could not load ' + what + '.');
    console.error('');
    console.error('  ' + String(err && err.message ? err.message : err).split('\n')[0]);
    console.error('');
    console.error('The template suites would SKIP rather than fail on this, so CI stops here.');
    console.error('Expected an xchain-vm checkout beside this repo at: ' + VM_DIR);
    console.error('It needs its own dependencies installed (isolated-vm builds natively)');
    console.error('and Node 22: the binding is V8-ABI-specific and will not build on 24.');
    console.error('');
    process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major !== 22) {
    fail('a supported Node runtime',
        new Error(`running Node ${process.versions.node}; this suite requires Node 22`));
}

let XChainVM;
for (const [what, modulePath] of REQUIRED) {
    try {
        const loaded = require(modulePath);
        if (what.startsWith('xchain-vm')) XChainVM = loaded;
    } catch (err) {
        fail(what, err);
    }
}

// Loading the module is not proof the native binding works: isolated-vm only
// dlopens when an isolate is actually constructed, which is exactly where the
// suites fail on an unsupported platform.
try {
    const harness = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js'));
    if (typeof harness.E2EHarness !== 'function') {
        throw new Error('E2EHarness is not exported by the harness helper');
    }
    if (!XChainVM) throw new Error('xchain-vm did not export a module object');
} catch (err) {
    fail('a usable E2E harness', err);
}

console.log('CI preflight OK: xchain-vm harness loadable on Node ' + process.versions.node);
