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
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { execFileSync } = require('child_process');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
const ROOT   = path.join(__dirname, '..');

// A suite file that registers no test at all reads green: mocha loads it, has
// nothing to run, and exits 0. Registration is counted by loading each file into
// a private Mocha instance in a child process (a same-process load would leave
// the files in the require cache and starve the real run), so every way a file
// can end up empty is caught by what it registers, not by how it is written.
const COUNT_SCRIPT = [
    "const loaded = require(process.env.PREFLIGHT_MOCHA);",
    "const Mocha = loaded.Mocha || loaded;",
    "const out = {};",
    "const count = (s) => s.tests.length + s.suites.reduce((n, c) => n + count(c), 0);",
    "const load = (file) => new Promise((resolve) => {",
    "  const m = new Mocha();",
    "  m.addFile(file);",
    "  m.loadFiles();",
    "  resolve({ count: count(m.suite) });",
    "}).then((r) => r, (e) => ({ error: String(e && e.message || e).split('\\n')[0] }));",
    "(async () => {",
    "  for (const file of process.argv.slice(1)) out[file] = await load(file);",
    "  process.stdout.write(JSON.stringify(out));",
    "})();"
].join('\n');

function mochaEntry() {
    return require.resolve('mocha', {
        paths: [ROOT, path.dirname(fs.realpathSync(process.argv[1]))]
    });
}

function registrationProblems(files) {
    const raw = execFileSync(process.execPath, ['-e', COUNT_SCRIPT, '--'].concat(files), {
        cwd: ROOT, env: Object.assign({}, process.env, { PREFLIGHT_MOCHA: mochaEntry() }), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024
    });
    const found = JSON.parse(raw);
    const problems = [];
    for (const file of files) {
        const r = found[file];
        if (!r) problems.push(file + ': not reported');
        else if (r.error) problems.push(file + ': failed to load (' + r.error + ')');
        else if (r.count < 1) problems.push(file + ': registers zero tests');
    }
    return problems;
}

function listedSuiteFiles() {
    const spec = require(path.join(ROOT, 'package.json')).scripts.test;
    return spec.split(/\s+/)
        .filter(function (t) { return /\.js$/.test(t); })
        .filter(function (t) { return path.resolve(ROOT, t) !== __filename; })
        .map(function (t) { return path.resolve(ROOT, t); });
}

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

    it('runs on Node 22 (the consensus runtime pins the V8 ABI)', function () {
        const major = Number(process.versions.node.split('.')[0]);
        assert.strictEqual(major, 22,
            'these suites require Node 22; running ' + process.versions.node +
            '. The VM pins the Node ABI to 127, so another major is not the ' +
            'fleet\'s engine, and a harness that fails to load makes every ' +
            'template suite SKIP rather than fail.');
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

describe('Preflight: no listed suite may register zero tests', function () {
    this.timeout(0);

    it('every suite wired into `npm test` registers at least one test', function () {
        const files = listedSuiteFiles();
        assert.ok(files.length > 0, 'no suite files found in scripts.test');
        assert.deepStrictEqual(registrationProblems(files), [],
            'a suite that registers nothing reports green while proving nothing');
    });

    describe('the registration check', function () {
        const CATCH = 'catch';
        const SHAPES = {
            'empty file':            '',
            'early return':          "describe('x', function () { return; it('a', function () {}); });",
            'test after a return':   "describe('x', function () { function f() { return 1; it('a', function () {}); } f(); });",
            'uninvoked callback':    "function later() { describe('x', function () { it('a', function () {}); }); }",
            'catch-only test':       "describe('x', function () { try { 1; } " + CATCH + " (e) { it('a', function () {}); } });"
        };
        let dir;
        before(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-shapes-')); });
        after(function () { fs.rmSync(dir, { recursive: true, force: true }); });

        function write(name, body) {
            const file = path.join(dir, name.replace(/\s+/g, '_') + '.test.js');
            fs.writeFileSync(file, body);
            return file;
        }

        Object.keys(SHAPES).forEach(function (name) {
            it('fails ' + name, function () {
                const problems = registrationProblems([write(name, SHAPES[name])]);
                assert.strictEqual(problems.length, 1);
                assert.ok(/registers zero tests/.test(problems[0]), problems[0]);
            });
        });

        it('fails a file that throws while loading', function () {
            const problems = registrationProblems([write('throws', "throw new Error('boom');")]);
            assert.ok(/failed to load/.test(problems[0]), String(problems[0]));
        });

        it('passes one real, invoked test', function () {
            const file = write('real', "describe('x', function () { it('a', function () {}); });");
            assert.deepStrictEqual(registrationProblems([file]), []);
        });
    });
});
