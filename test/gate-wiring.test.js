// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// gate-wiring.test.js: the false-green guard must stay wired in.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// test/preflight.test.js only protects `npm test` while it is actually listed
// in the `test` script, and it only protects the WHOLE run while it is listed
// FIRST. Both are one careless edit away from being lost, and losing them is
// invisible: the suite goes back to 52 passing / 243 pending / exit 0, which
// looks exactly like success.
//
// This file is the lock on that wiring. It needs no VM, so it runs and reports
// on every platform, including the machines where the preflight itself is red.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/gate-wiring.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_DIR = path.join(__dirname, '..');
const PKG      = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));

const PREFLIGHT = 'test/preflight.test.js';

// The spec paths the `test` script hands to mocha, in order.
function testScriptSpecs() {
    return String(PKG.scripts.test || '')
        .split(/\s+/)
        .filter(tok => tok.endsWith('.test.js'));
}

// Every *.test.js in the repo, repo-relative, excluding installed packages.
function discoverTestFiles(dir, out) {
    out = out || [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) discoverTestFiles(full, out);
        else if (entry.name.endsWith('.test.js')) out.push(path.relative(REPO_DIR, full));
    }
    return out;
}

describe('gate wiring: the preflight cannot be dropped silently', function () {

    it('`npm test` runs the preflight', function () {
        assert.ok(testScriptSpecs().includes(PREFLIGHT),
            'package.json scripts.test no longer runs ' + PREFLIGHT + '. Without it, a ' +
            'machine that cannot load isolated-vm reports a green run over a suite that ' +
            'skipped most of itself.');
    });

    it('the preflight runs FIRST, so the failure heads the report', function () {
        const specs = testScriptSpecs();
        assert.strictEqual(specs[0], PREFLIGHT,
            'the preflight must be the first spec in scripts.test so its failure is the ' +
            'first thing a reader sees; found ' + specs[0]);
    });

    it('`npm run ci` still runs the standalone preflight before the suites', function () {
        const ci = String(PKG.scripts.ci || '');
        assert.ok(/ci-preflight\.js/.test(ci),
            'scripts.ci must run bin/ci-preflight.js so CI fails before mocha even starts');
        assert.ok(ci.indexOf('ci-preflight.js') < ci.indexOf('npm test'),
            'bin/ci-preflight.js must run BEFORE npm test in scripts.ci');
    });

    it('the preflight itself can never degrade to a skip', function () {
        const src = fs.readFileSync(path.join(REPO_DIR, PREFLIGHT), 'utf8');
        const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        assert.ok(!/describe\.skip|it\.skip|this\.skip\(/.test(code),
            PREFLIGHT + ' must fail on an unloadable harness, never skip; a skip here ' +
            'restores the exact false green the file exists to prevent');
        assert.ok(!/\bcatch\s*\(/.test(code),
            PREFLIGHT + ' must not swallow a require failure in a catch block');
    });

    it('every spec listed in scripts.test exists on disk', function () {
        const missing = testScriptSpecs()
            .filter(spec => !fs.existsSync(path.join(REPO_DIR, spec)));
        assert.deepStrictEqual(missing, [],
            'scripts.test names spec files that do not exist; mocha would run a smaller ' +
            'suite than the script claims');
    });

    it('every test file in the repo is inside the gated run', function () {
        const listed = new Set(testScriptSpecs());
        const orphans = discoverTestFiles(REPO_DIR).filter(f => !listed.has(f));
        assert.deepStrictEqual(orphans, [],
            'these *.test.js files are not listed in scripts.test, so `npm test` never ' +
            'runs them and their coverage is imaginary: ' + orphans.join(', '));
    });

    it('every suite that degrades to describe.skip is inside the gated run', function () {
        // A soft-skipping suite outside the gate is the exact false-green shape
        // this repo already paid for once, so it is asserted separately from the
        // orphan check above: this one names the mechanism in its failure.
        const listed = new Set(testScriptSpecs());
        const skippers = discoverTestFiles(REPO_DIR)
            .filter(f => /describe\.skip/.test(fs.readFileSync(path.join(REPO_DIR, f), 'utf8')))
            .filter(f => !listed.has(f));
        assert.deepStrictEqual(skippers, [],
            'these suites can silently become pending and are not in scripts.test, so ' +
            'nothing proves they ever ran: ' + skippers.join(', '));
    });
});
