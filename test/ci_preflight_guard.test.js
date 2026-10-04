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
});
