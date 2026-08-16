// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// preflight.test.js: the sandbox engine must LOAD, or the run turns red.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Why this file exists
// --------------------
// Every template suite in this repo wraps its `describe` in
// `(XChainVM ? describe : describe.skip)` and swallows the require error.
// That is deliberate ergonomics: a developer on macOS, where the isolated-vm
// binary in the shared node_modules is a Linux build, gets one tidy "skipping"
// line instead of seventeen ERR_DLOPEN_FAILED stacks.
//
// The cost of that choice is a FALSE GREEN. With the harness unloadable,
// `npm test` reported 52 passing / 243 pending and exited 0: 82 percent of the
// suite silently vanished and the runner still said success. A human or an
// agent reporting "52 passing, 0 failing" off that run is being honest and
// telling you nothing, and no test SELECTION can defend against it because the
// venue itself is what decided which tests exist.
//
// bin/ci-preflight.js closed that hole for `npm run ci`, but `npm test` is the
// command people actually type, and it ran unguarded. This file is the same
// proof living INSIDE the mocha run, wired first in the `test` script, so the
// guarantee cannot be bypassed by choosing the shorter command.
//
// There is no try/catch here on purpose: a load failure MUST fail, never skip.
//
// ERR_DLOPEN_FAILED / "slice is not valid mach-o file" means the isolated-vm
// binary was built for another platform or another Node/V8 ABI. That is the
// expected state on this Mac (the shared NFS node_modules holds the Linux
// build), and it is the whole reason contract work verifies on DankServer
// under Node 22 rather than locally.

'use strict';

const assert = require('assert');
const path   = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');

// A raw ERR_DLOPEN_FAILED stack says the binding did not load; it does not say
// that the rest of the report is meaningless. The banner does, and it is
// printed from an exit handler so it lands AFTER mocha's epilogue rather than
// scrolling away above 250 pending lines.
let isolateChecked = false;
let harnessUsable  = false;
process.on('exit', function () {
    if (!isolateChecked || harnessUsable) return;
    console.error('');
    console.error('  ==================================================================');
    console.error('  THE HARNESS DID NOT LOAD. THIS RUN PROVES NOTHING ABOUT CONTRACTS.');
    console.error('  ------------------------------------------------------------------');
    // Deliberately does not spell the soft-skip helper's name: gate-wiring's
    // "the preflight can never degrade to a skip" check greps this file's code.
    console.error('  Every template suite above was skipped rather than run, so the');
    console.error('  "pending" count is the contract coverage you did NOT get. Only the');
    console.error('  preflight and the VM-free lint/policy tests actually executed.');
    console.error('');
    console.error('  Expected sibling checkout: ' + VM_DIR);
    console.error('  It needs its own dependencies installed (isolated-vm builds');
    console.error('  natively) and Node 22 (the binding is V8-ABI-specific).');
    console.error('');
    console.error('  On macOS the shared node_modules holds a Linux build, so this');
    console.error('  failure is expected here and is not fixable by re-running:');
    console.error('  verify contract work on the Linux venue under Node 22.');
    console.error('  ==================================================================');
    console.error('');
});

describe('Preflight: the xchain-vm harness must be usable', function () {
    this.timeout(0);

    it('runs on Node 22 (isolated-vm is V8-ABI-specific)', function () {
        const major = Number(process.versions.node.split('.')[0]);
        assert.strictEqual(major, 22,
            'these suites require Node 22; running ' + process.versions.node +
            '. isolated-vm 5.0.4 does not build on 24, and a harness that fails ' +
            'to load makes every template suite SKIP rather than fail.');
    });

    it('loads the xchain-vm entrypoint from the sibling checkout', function () {
        const XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
        assert.strictEqual(typeof XChainVM, 'function',
            'xchain-vm src/index.js should export the XChainVM constructor; ' +
            'expected a sibling checkout with its dependencies installed at ' + VM_DIR);
    });

    it('loads the e2e harness and assertion helpers the templates use', function () {
        const { E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js'));
        assert.strictEqual(typeof E2EHarness, 'function',
            'E2EHarness is not exported by the harness helper');

        const assertions = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js'));
        for (const name of ['assertSuccess', 'assertReverted', 'assertEmittedActions',
                            'assertBalance', 'assertContractBalance', 'assertContractState']) {
            assert.strictEqual(typeof assertions[name], 'function',
                'the assertions helper does not export ' + name);
        }
    });

    // Requiring the module is NOT proof the native binding works: isolated-vm
    // only dlopens when an isolate is actually constructed, which is exactly
    // where the template suites would fail on an unsupported platform.
    it('executes a trivial contract inside a real isolate', async function () {
        isolateChecked = true;
        const XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
        const { E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js'));

        const h = new E2EHarness(XChainVM);
        const ADDR = 'C:BTC:PREFLIGHT';

        const deployed = await h.deploy({
            code: 'module.exports = function (xchain) { return "ok"; };',
            deployer: 'preflight_addr',
            contractAddress: ADDR
        });
        assert.strictEqual(deployed.success, true,
            'trivial contract failed to deploy: ' + deployed.error);

        const r = await h.execute({
            contractAddress: ADDR, method: 'default', params: [], caller: 'preflight_addr'
        });
        assert.strictEqual(r.success, true,
            'trivial contract failed to execute: ' + r.error);
        assert.strictEqual(JSON.parse(r.returnValue), 'ok');
        harnessUsable = true;
    });
});
