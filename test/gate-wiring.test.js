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

// Every shipped contract template, by the SAME predicate the two discovery sites
// use: a directory holding <name>/<name>.js. bin/xchain-contracts.js listAvailable()
// fans `lint` out over exactly this set, and ../xchain-vm/test/unit/lint-parity.test.js
// runs exactly this set through the authoritative validateSyntax. `patterns`, `lib`,
// `bin` and `test` drop out naturally because none of them holds <dir>/<dir>.js, so
// this needs no allowlist that could drift from theirs.
function discoverTemplates() {
    const names = [];
    for (const entry of fs.readdirSync(REPO_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (fs.existsSync(path.join(REPO_DIR, entry.name, entry.name + '.js'))) names.push(entry.name);
    }
    return names.sort();
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

    // The three checks above all run test-file -> gated-run. Nothing ran the inverse,
    // template -> test file, so a new <name>/<name>.js would be discovered and linted
    // by listAvailable() and by xchain-vm's lint-parity while never once executing in
    // the VM, and every gate above would stay green over it. That is the same
    // "parity asserted but never exercised" false green this file exists to lock down,
    // one direction round.
    it('every discovered template has an adjacent <name>.test.js', function () {
        const templates = discoverTemplates();
        assert.ok(templates.length > 0,
            'template discovery found nothing; the <name>/<name>.js predicate has drifted from ' +
            'bin/xchain-contracts.js listAvailable() and this guard is now inert');
        const missing = templates.filter(n => !fs.existsSync(path.join(REPO_DIR, n, n + '.test.js')));
        assert.deepStrictEqual(missing, [],
            'these templates are discovered and linted but have no suite, so they would ship as ' +
            'audited with imaginary VM coverage: ' + missing.join(', '));
    });

    // Same template -> artifact direction as the check above, one artifact over. The
    // `abi` block is advisory (no VM or indexer reads it), so nothing anywhere goes red
    // when a template ships without one: it just renders in wallets and explorers with
    // no method summaries and no param names, which for a template whose privileged
    // method is an owner-only sweep is exactly the method a reader needed to see. Three
    // of fourteen had drifted out of the family before this was asserted. `require()`
    // the module rather than string-matching, so a block that is present but malformed
    // (no version, empty methods) fails here too.
    it('every discovered template declares an advisory abi block', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try {
                mod = require(path.join(REPO_DIR, name, name + '.js'));
            } catch (err) {
                offenders.push(name + ' (does not load: ' + err.message + ')');
                continue;
            }
            const abi = mod && mod.abi;
            if (!abi || typeof abi !== 'object') { offenders.push(name + ' (no abi block)'); continue; }
            if (abi.version !== 1) { offenders.push(name + ' (abi.version is not 1)'); continue; }
            if (!abi.methods || typeof abi.methods !== 'object' || Object.keys(abi.methods).length === 0)
                offenders.push(name + ' (abi.methods is missing or empty)');
        }
        assert.deepStrictEqual(offenders, [],
            'these templates ship with no usable display metadata, so wallets and explorers ' +
            'render their methods bare: ' + offenders.join(', '));
    });

    it('every template suite deploys its template through the real VM', function () {
        // Existence alone is satisfied by a stub that only lints the source, which
        // leaves exactly the coverage hole above. Assert the suite reaches
        // xchain-vm/test/e2e/helpers/harness.js and calls deploy on it. String
        // matching only: this file must keep reporting on machines where isolated-vm
        // will not load, which is the whole reason it is separate from the preflight.
        const offenders = [];
        for (const name of discoverTemplates()) {
            const spec = path.join(REPO_DIR, name, name + '.test.js');
            if (!fs.existsSync(spec)) continue;   // named by the previous test
            const src = fs.readFileSync(spec, 'utf8');
            const bootsVm = /E2EHarness/.test(src) || /e2e[\/\\]helpers[\/\\]harness/.test(src);
            const deploys = /\.deploy\s*\(/.test(src);
            if (!bootsVm || !deploys) offenders.push(name);
        }
        assert.deepStrictEqual(offenders, [],
            'these template suites never deploy through the E2E harness, so the template is ' +
            'lint-only however green the run looks: ' + offenders.join(', '));
    });

    // Patterns are shipped source too, but they are NOT <name>/<name>.js, so the two
    // checks above skip them by construction and the same false green reopens one
    // directory over: patterns/patterns.e2e.test.js is the only suite that runs pattern
    // source through the VM, and it degrades to describe.skip wherever isolated-vm will
    // not load. String matching only, for that exact reason (see the note above).
    it('every pattern source contributes a helper the VM-deployed vault calls', function () {
        const dir   = path.join(REPO_DIR, 'patterns');
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).sort();
        assert.ok(files.length > 0,
            'pattern discovery found nothing; the predicate has drifted from ' +
            'bin/xchain-contracts.js listAvailable() and this guard is now inert');

        // Same extraction oz-aliases.test.js uses for the paste-in helper set.
        const fnsOf = (f) => {
            const re = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
            const src = fs.readFileSync(path.join(dir, f), 'utf8');
            const out = [];
            let m;
            while ((m = re.exec(src)) !== null) out.push(m[1]);
            return out;
        };

        // patterns.e2e.test.js concatenates every file into one script, so a repeated
        // top-level name silently shadows the earlier definition, last file wins.
        const seen    = new Map();
        const clashes = [];
        for (const f of files) {
            for (const fn of fnsOf(f)) {
                if (seen.has(fn)) clashes.push(fn + ' (' + seen.get(fn) + ' vs ' + f + ')');
                else seen.set(fn, f);
            }
        }
        assert.deepStrictEqual(clashes, [],
            'these helper names are declared in more than one pattern file, so the composed ' +
            'e2e vault silently runs whichever came last: ' + clashes.join(', '));

        const e2e = fs.readFileSync(path.join(dir, 'patterns.e2e.test.js'), 'utf8');
        const offenders = files.filter(f => {
            const fns = fnsOf(f);
            return fns.length === 0 || !fns.some(fn => new RegExp('\\b' + fn + '\\s*\\(').test(e2e));
        });
        assert.deepStrictEqual(offenders, [],
            'these pattern sources are listed, scaffolded and linted but no helper of theirs is ' +
            'ever called in the vault patterns.e2e.test.js deploys, so their VM coverage is ' +
            'imaginary: ' + offenders.join(', '));
    });
});
