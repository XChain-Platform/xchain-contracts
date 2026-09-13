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

// The injector's fixed attestation preamble, mirroring xchain-indexer/src/actions/
// attest.js _injectCallbackExecute():
//
//   callbackArgs = [request_id, provider_id, status, response_payload, ...callback_params]
//
// Slots 0-3 are on the wire for EVERY attestation callback the indexer fires,
// whether or not the contract body ever reads them, so a callback's true arity is
// 4 + the length of the context array the contract handed attestation.request().
// Types: the first three are always indexer strings; slot 3 carries whatever the
// provider returned, so its declared type is the template's call to make.
const PREAMBLE = [
    { name: 'requestId',  type: 'string' },
    { name: 'providerId', type: 'string' },
    { name: 'status',     type: 'string' },
    { name: 'responsePayload' }
];

// Blank out comments (preserving offsets and line structure) so an argument list
// that carries inline documentation - urlOracle's does, one comment per argument -
// still splits on its real commas. String state is tracked so a '//' inside a URL
// literal is not mistaken for a comment.
function blankComments(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            out += c; i++;
            while (i < src.length) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
                out += src[i];
                if (src[i] === quote) { i++; break; }
                i++;
            }
            continue;
        }
        if (c === '/' && src[i + 1] === '/') {
            while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) { out += (src[i] === '\n' ? '\n' : ' '); i++; }
            out += '  '; i += 2;
            continue;
        }
        out += c; i++;
    }
    return out;
}

// Split a bracketed list at top level. `open` is the index of the opening bracket;
// returns the trimmed source of each element, or null if the bracket never closes.
function splitList(src, open) {
    const PAIRS = { '(': ')', '[': ']', '{': '}' };
    const close = PAIRS[src[open]];
    const args  = [];
    let depth = 0, start = open + 1, i = open;
    for (; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            const quote = c;
            i++;
            while (i < src.length && src[i] !== quote) { if (src[i] === '\\') i++; i++; }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') { depth++; continue; }
        if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) {
                const tail = src.slice(start, i).trim();
                if (tail.length > 0 || args.length > 0) args.push(tail);
                return (c === close) ? args : null;
            }
            continue;
        }
        if (c === ',' && depth === 1) { args.push(src.slice(start, i).trim()); start = i + 1; }
    }
    return null;
}

const STRING_LITERAL = /^(['"])([A-Za-z_$][A-Za-z0-9_$]*)\1$/;

// Every xchain.attestation.request() call site in one template's source, with the
// callback method name and the context-array length it registers.
function callbackRegistrations(src) {
    const clean = blankComments(src);
    const re    = /xchain\s*\.\s*attestation\s*\.\s*request\s*\(/g;
    const sites = [];
    let m;
    while ((m = re.exec(clean)) !== null) {
        const open = clean.indexOf('(', m.index);
        const args = splitList(clean, open);
        const site = { args: args };
        if (args && args.length >= 4) {
            const name = STRING_LITERAL.exec(args[2]);
            site.method = name ? name[2] : null;
            if (args[3][0] === '[') {
                const els = splitList(args[3], 0);
                site.context = els ? els.length : null;
            } else {
                site.context = null;
            }
        }
        sites.push(site);
    }
    return sites;
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

    // Guard the param SHAPE the check above does not reach (the fail-closed readers drop
    // a whole method entry, summary and view included, on one malformed params element).
    // ABI_PARAM_TYPES mirrors xchain-sdk/src/contract/abi-core.js:40, the source of truth.
    it('every abi method declares its params as { name, type } object literals', function () {
        const ABI_PARAM_TYPES = ['string', 'number', 'amount', 'address', 'tick', 'bool', 'json'];
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try {
                mod = require(path.join(REPO_DIR, name, name + '.js'));
            } catch (err) {
                offenders.push(name + ' (does not load: ' + err.message + ')');
                continue;
            }
            const methods = (mod && mod.abi && mod.abi.methods) || {};
            for (const [method, spec] of Object.entries(methods)) {
                const where = name + '.' + method;
                const params = spec && spec.params;
                if (params === undefined) continue;
                if (!Array.isArray(params)) { offenders.push(where + ' (params is not an array)'); continue; }
                params.forEach(function (el, i) {
                    const at = where + '[' + i + ']';
                    if (!el || typeof el !== 'object' || Array.isArray(el)) offenders.push(at + ' (not an object literal)');
                    else if (typeof el.name !== 'string' || el.name.length === 0) offenders.push(at + ' (no string name)');
                    else if (ABI_PARAM_TYPES.indexOf(el.type) === -1) offenders.push(at + ' (type ' + JSON.stringify(el.type) + ' is not an allowed abi param type)');
                });
            }
        }
        assert.deepStrictEqual(offenders, [],
            'the fail-closed abi readers drop the whole method entry for each of these, so its ' +
            'summary, param names and view flag never reach a wallet or explorer: ' + offenders.join(', '));
    });

    // Same template -> artifact direction again, on the one export key that is NOT
    // advisory. Under the CONTRACT_META_REQUIRED flag day the indexer reads `meta` off
    // the deployed export and refuses the DEPLOY outright when name or description is
    // missing, so a template that ships without it is undeployable on a meta-active
    // chain and every other gate in this repo stays green over it: the linter is
    // advisory, and the template suites deploy on a regtest harness whose flag day need
    // not be armed. `require()` the module rather than string-matching, so a block that
    // is present but malformed (empty name, non-string version) fails here too.
    it('every discovered template declares a consensus-required meta block', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try {
                mod = require(path.join(REPO_DIR, name, name + '.js'));
            } catch (err) {
                offenders.push(name + ' (does not load: ' + err.message + ')');
                continue;
            }
            const meta = mod && mod.meta;
            if (!meta || typeof meta !== 'object' || Array.isArray(meta)) { offenders.push(name + ' (no meta block)'); continue; }
            if (typeof meta.name !== 'string' || meta.name.length === 0) { offenders.push(name + ' (meta.name is missing or empty)'); continue; }
            if (typeof meta.description !== 'string' || meta.description.length === 0) { offenders.push(name + ' (meta.description is missing or empty)'); continue; }
            if (meta.version !== undefined && typeof meta.version !== 'string')
                offenders.push(name + ' (meta.version is present but not a string)');
        }
        assert.deepStrictEqual(offenders, [],
            'consensus rejects a DEPLOY of these templates with "invalid: CONTRACT_MANIFEST ' +
            '(meta required)", so anyone who scaffolds one pays a fee for a refused deploy: ' +
            offenders.join(', '));
    });

    // Key ORDER is a house convention, not a consensus rule, and nothing else asserts
    // it: identity reads first in the file and in every diff of it, which is the point
    // of putting it above the advisory `abi` block. Cheap to keep, invisible to lose.
    it('every discovered template declares meta as the first exported key', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try {
                mod = require(path.join(REPO_DIR, name, name + '.js'));
            } catch (err) { continue; }   // named by the meta check above
            const first = Object.keys(mod)[0];
            if (first !== 'meta') offenders.push(name + ' (first key is ' + JSON.stringify(first) + ')');
        }
        assert.deepStrictEqual(offenders, [],
            'meta must be the first key of module.exports, above abi, so a reader sees what the ' +
            'contract IS before what it documents: ' + offenders.join(', '));
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

        // Per HELPER, not per file. A file-granular check passes as soon as ONE of a
        // file's helpers is called, which is how seven shipped helpers - onlyRole,
        // isOwner, isPaused, requireHeld, depositedSince, requireStatusIn, requireEnum,
        // among them whole oz-aliases.json rows - carried lint and compile coverage
        // only while every gate read green.
        const empty = files.filter(f => fnsOf(f).length === 0);
        assert.deepStrictEqual(empty, [],
            'these pattern sources declare no top-level helper at all, so the extraction ' +
            'predicate has drifted and this guard is inert for them: ' + empty.join(', '));

        const uncalled = [];
        for (const f of files) {
            for (const fn of fnsOf(f)) {
                if (!new RegExp('\\b' + fn + '\\s*\\(').test(e2e)) uncalled.push(f + ':' + fn);
            }
        }
        assert.deepStrictEqual(uncalled, [],
            'these pattern helpers are listed, scaffolded and linted but never called in any ' +
            'contract patterns.e2e.test.js deploys, so their VM coverage is imaginary: ' +
            uncalled.join(', '));
    });
});

// Every check above reads a template against an artifact of its own. This one reads
// it against the CALLER: the indexer fires attestation callbacks with a four-slot
// preamble the contract never names, so the declared signature and the wire signature
// can disagree while every other gate stays green.
//
// The arity here is derived from the injector's own rule (4 + the context array the
// contract registered), never from the getInputParam indices the callback body
// happens to read. That distinction is the whole point: a callback that reads only
// slot 0 - escrowDelivery.onDelivery and urlOracle.onPrice both did - passes any
// reads-derived scan while declaring one param against a four-param wire, which is
// exactly how two instances of this survived the round that found the first two.
describe('attestation callbacks: arity is the injector\'s, not the contract\'s reads', function () {

    // Guard the scanner itself. If blankComments or splitList quietly stops finding
    // call sites, every assertion below passes over an empty set and the family of
    // checks goes inert without a single red test - the same false-green shape the
    // rest of this file exists to lock down.
    it('the scan actually finds the registrations that exist', function () {
        const found = [];
        for (const name of discoverTemplates()) {
            const src = fs.readFileSync(path.join(REPO_DIR, name, name + '.js'), 'utf8');
            for (const site of callbackRegistrations(src)) found.push(name + '.' + site.method);
        }
        assert.ok(found.length >= 3,
            'the attestation.request() scan found ' + found.length + ' call sites across ' +
            'the templates; it found 3 when it was written, so the parser has broken and ' +
            'every callback assertion below is now vacuous. Found: ' + found.join(', '));

        // Registered inline, with comments between the arguments (urlOracle) and with a
        // non-empty context array (counterpartyBridge): the two shapes the parser can
        // regress on independently.
        assert.ok(found.indexOf('urlOracle.onPrice') !== -1,
            'the scan no longer sees urlOracle.onPrice, whose arguments are separated by ' +
            'inline comments; comment blanking has regressed. Found: ' + found.join(', '));
        assert.ok(found.indexOf('counterpartyBridge.onClaim') !== -1,
            'the scan no longer sees counterpartyBridge.onClaim, the only site with a ' +
            'non-empty context array. Found: ' + found.join(', '));
    });

    it('every registration is parseable, so no callback escapes certification', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            const src = fs.readFileSync(path.join(REPO_DIR, name, name + '.js'), 'utf8');
            callbackRegistrations(src).forEach(function (site, i) {
                const where = name + ' attestation.request()#' + i;
                if (!site.args)              { offenders.push(where + ' (argument list does not close)'); return; }
                if (site.args.length < 4)    { offenders.push(where + ' (only ' + site.args.length + ' arguments; the callback method and context array are required)'); return; }
                if (!site.method)            { offenders.push(where + ' (callback method is not a plain string literal, so its abi entry cannot be located)'); return; }
                if (site.context === null)   offenders.push(where + ' (context is not an array literal, so the callback arity cannot be derived)');
            });
        }
        assert.deepStrictEqual(offenders, [],
            'these attestation registrations cannot be read statically, so the preamble check ' +
            'below silently skips them and the callback ships uncertified: ' + offenders.join(', '));
    });

    it('every registered callback declares the full injector arity in its abi', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try { mod = require(path.join(REPO_DIR, name, name + '.js')); }
            catch (err) { continue; }   // named by the meta/abi checks above
            const src     = fs.readFileSync(path.join(REPO_DIR, name, name + '.js'), 'utf8');
            const methods = (mod && mod.abi && mod.abi.methods) || {};
            for (const site of callbackRegistrations(src)) {
                if (!site.method || site.context === null) continue;   // named by the previous test
                const where = name + '.' + site.method;
                if (typeof mod[site.method] !== 'function') {
                    offenders.push(where + ' (registered as a callback but not exported, so the injected EXECUTE reverts)');
                    continue;
                }
                const spec = methods[site.method];
                if (!spec) { offenders.push(where + ' (registered as a callback with no abi entry)'); continue; }
                const params = spec.params;
                if (!Array.isArray(params)) { offenders.push(where + ' (abi params is not an array)'); continue; }
                const expected = PREAMBLE.length + site.context;
                if (params.length !== expected) {
                    offenders.push(where + ' (declares ' + params.length + ' param(s); the injector sends ' +
                                   expected + ': the ' + PREAMBLE.length + '-slot preamble plus ' + site.context +
                                   ' registered context value(s))');
                }
            }
        }
        assert.deepStrictEqual(offenders, [],
            'the indexer sends every attestation callback [request_id, provider_id, status, ' +
            'response_payload, ...context] (attest.js _injectCallbackExecute), so these declared ' +
            'signatures are wrong on the wire and anyone reading the abi picks the wrong slot ' +
            'index: ' + offenders.join(', '));
    });

    it('every registered callback names the preamble slots in injector order', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try { mod = require(path.join(REPO_DIR, name, name + '.js')); }
            catch (err) { continue; }
            const src     = fs.readFileSync(path.join(REPO_DIR, name, name + '.js'), 'utf8');
            const methods = (mod && mod.abi && mod.abi.methods) || {};
            for (const site of callbackRegistrations(src)) {
                if (!site.method) continue;
                const params = (methods[site.method] || {}).params;
                if (!Array.isArray(params)) continue;   // named above
                PREAMBLE.forEach(function (slot, i) {
                    const at = name + '.' + site.method + '[' + i + ']';
                    const el = params[i];
                    if (!el || typeof el !== 'object') { offenders.push(at + ' (missing; expected ' + slot.name + ')'); return; }
                    if (el.name !== slot.name) offenders.push(at + ' (named ' + JSON.stringify(el.name) + ', the injector puts ' + slot.name + ' here)');
                    if (slot.type && el.type !== slot.type) offenders.push(at + ' (type ' + JSON.stringify(el.type) + '; the indexer always sends ' + slot.type + ' here)');
                });
            }
        }
        assert.deepStrictEqual(offenders, [],
            'the preamble slots arrive in a fixed order, so a template that renames or reorders ' +
            'them documents a wire that does not exist: ' + offenders.join(', '));
    });

    // The inverse direction, keyed on behaviour rather than on the word "callback" in a
    // summary (treasury.arm is a POLL finalization callback with a different, longer
    // wire). A method that reads an attestation response is one the injector fires, so
    // if no attestation.request() in the same template registers it, nothing anywhere
    // pins its declared arity to the preamble - which is the state every callback in
    // this repo was in until the check above existed.
    it('every method that reads an attestation response is registered as a callback', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            let mod;
            try { mod = require(path.join(REPO_DIR, name, name + '.js')); }
            catch (err) { continue; }
            const src        = fs.readFileSync(path.join(REPO_DIR, name, name + '.js'), 'utf8');
            const registered = new Set(callbackRegistrations(src).map(s => s.method).filter(Boolean));
            for (const [method, fn] of Object.entries(mod)) {
                if (typeof fn !== 'function') continue;
                if (!/xchain\s*\.\s*attestation\s*\.\s*getResponse\s*\(/.test(blankComments(String(fn)))) continue;
                if (!registered.has(method)) offenders.push(name + '.' + method);
            }
        }
        assert.deepStrictEqual(offenders, [],
            'these methods consume an attestation response but no attestation.request() in the ' +
            'same template names them as its callback, so their wire signature is derived from ' +
            'nothing: ' + offenders.join(', '));
    });
});
