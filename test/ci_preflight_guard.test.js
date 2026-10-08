// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// ci_preflight_guard.test.js: bin/ci-preflight.js must run clean and keep its scope.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// gate-wiring.test.js only proves the preflight suite is wired first in the
// `test` script. Nothing ran the standalone CI guard itself, so a guard that
// crashed or was narrowed to check fewer files would still read as green.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'bin', 'ci-preflight.js');

describe('bin/ci-preflight.js', function () {
    it('exits 0 with empty stderr on this checkout', function () {
        const res = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' });
        assert.strictEqual(res.error, undefined);
        assert.strictEqual(res.status, 0, 'stderr: ' + res.stderr);
        assert.strictEqual(res.stderr, '');
    });

    it('still requires the xchain-vm entrypoint and e2e harness', function () {
        const src = fs.readFileSync(SCRIPT, 'utf8');
        assert.ok(/VM_DIR\s*=\s*path\.join\(__dirname,\s*'\.\.',\s*'\.\.',\s*'xchain-vm'\)/.test(src),
            'VM_DIR no longer points at the sibling xchain-vm');
        const start = src.indexOf('const REQUIRED');
        const block = src.slice(start, src.indexOf('];', start));
        assert.ok(/path\.join\(VM_DIR,\s*'src',\s*'index\.js'\)/.test(block), 'src/index.js dropped from REQUIRED');
        assert.ok(/path\.join\(VM_DIR,\s*'test',\s*'e2e',\s*'helpers',\s*'harness\.js'\)/.test(block),
            'test/e2e/helpers/harness.js dropped from REQUIRED');
    });

    it('runs the same isolate probe as the mocha preflight', function () {
        for (const file of [SCRIPT, path.join(ROOT, 'test', 'preflight.test.js')]) {
            const src = fs.readFileSync(file, 'utf8');
            assert.ok(/require\('\.\.\/lib\/isolate_probe\.js'\)/.test(src), file + ' no longer loads the shared probe');
            assert.ok(/await runIsolateProbe\(/.test(src), file + ' no longer awaits the shared probe');
        }
    });
});

// A stub harness whose deploy and execute return the given results.
function stubHarness(deployed, executed) {
    return class StubHarness {
        async deploy() { return deployed; }
        async execute() { return executed; }
    };
}

describe('lib/isolate_probe.js checks results, not just calls', function () {
    const { runIsolateProbe } = require('../lib/isolate_probe.js');
    const OK = { success: true, returnValue: '"ok"' };

    it('rejects a failed deploy', async function () {
        await assert.rejects(runIsolateProbe(function VM() {}, stubHarness({ success: false, error: 'stub' }, OK)), /deploy: stub/);
    });

    it('rejects a failed execute', async function () {
        await assert.rejects(runIsolateProbe(function VM() {}, stubHarness(OK, { success: false, error: 'stub' })), /execute: stub/);
    });

    it('rejects a wrong return value', async function () {
        await assert.rejects(runIsolateProbe(function VM() {}, stubHarness(OK, { success: true, returnValue: '"nope"' })), /expected "ok"/);
    });

    it('resolves when the contract returns ok', async function () {
        await runIsolateProbe(function VM() {}, stubHarness(OK, OK));
    });
});
