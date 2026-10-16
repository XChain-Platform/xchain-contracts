// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// gate-wiring.test.js: the false-green guard must stay wired in.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// preflight.test.js only protects `npm test` while it is listed in the `test` script,
// and the whole run only while it is listed FIRST; losing either is invisible (the suite
// reads 52 passing / 243 pending / exit 0). This file locks that wiring. It needs no VM,
// so it reports on every platform, even where the preflight itself is red.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/gate-wiring.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_DIR  = path.join(__dirname, '..');
const PKG       = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
const PREFLIGHT = 'test/preflight.test.js';

const read       = (...p) => fs.readFileSync(path.join(REPO_DIR, ...p), 'utf8');
const tplSrc     = (n) => read(n, n + '.js');
const tplPath    = (n) => path.join(REPO_DIR, n, n + '.js');
const abiMethods = (mod) => (mod && mod.abi && mod.abi.methods) || {};
const none       = (offenders, msg) => assert.deepStrictEqual(offenders, [], msg + offenders.join(', '));

function suitePath(name) {
    const snake = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    const modern = path.join(REPO_DIR, name, snake + '.test.js');
    return fs.existsSync(modern) ? modern : path.join(REPO_DIR, name, name + '.test.js');
}

const testScriptSpecs = () => String(PKG.scripts.test || '').split(/\s+/).filter(t => t.endsWith('.test.js'));

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

function discoverTemplates() {
    return fs.readdirSync(REPO_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
        .filter(e => fs.existsSync(tplPath(e.name)))
        .map(e => e.name).sort();
}

function loadTemplate(name) {
    try { return { mod: require(tplPath(name)) }; } catch (err) { return { err: err }; }
}
function templateOffenders(problem) {
    const out = [];
    for (const name of discoverTemplates()) {
        const loaded = loadTemplate(name);
        const why = loaded.err ? 'does not load: ' + loaded.err.message : problem(loaded.mod);
        if (why) out.push(name + ' (' + why + ')');
    }
    return out;
}

function offendersOverLoaded(check) {
    const out = [];
    for (const name of discoverTemplates()) { const l = loadTemplate(name); if (!l.err) check(name, l.mod, out); }
    return out;
}

// The injector's fixed attestation preamble (xchain-indexer attest/index.js
// injectCallbackExecute): [request_id, provider_id, status, response_payload, ...context].
const PREAMBLE = [{ name: 'requestId', type: 'string' }, { name: 'providerId', type: 'string' },
                  { name: 'status', type: 'string' }, { name: 'responsePayload' }];

const TOKEN = /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const blankComments = (src) => src.replace(TOKEN, (m, str) => str || m.replace(/[^\n]/g, ' '));

function deployedContractCode(src) {
    return [...blankComments(src).matchAll(/`([^`]*)`/g)].map(m => blankComments(m[1])).join('\n');
}

const callsHelper = (code, fn) => new RegExp('\\b' + fn + '\\s*\\(').test(code);

function splitList(src, open) {
    const close = { '(': ')', '[': ']', '{': '}' }[src[open]];
    const args  = [];
    let depth = 0, start = open + 1;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (c === '"' || c === "'" || c === '`') {
            i++;
            while (i < src.length && src[i] !== c) { if (src[i] === '\\') i++; i++; }
        } else if (c === '(' || c === '[' || c === '{') {
            depth++;
        } else if (c === ')' || c === ']' || c === '}') {
            if (--depth !== 0) continue;
            const tail = src.slice(start, i).trim();
            if (tail.length > 0 || args.length > 0) args.push(tail);
            return (c === close) ? args : null;
        } else if (c === ',' && depth === 1) {
            args.push(src.slice(start, i).trim()); start = i + 1;
        }
    }
    return null;
}

const STRING_LITERAL = /^(['"])([A-Za-z_$][A-Za-z0-9_$]*)\1$/;

function callbackRegistrations(src) {
    const clean = blankComments(src);
    const re    = /xchain\s*\.\s*attestation\s*\.\s*request\s*\(/g;
    const sites = [];
    let m;
    while ((m = re.exec(clean)) !== null) {
        const args = splitList(clean, clean.indexOf('(', m.index));
        const site = { args: args };
        if (args && args.length >= 4) {
            const name = STRING_LITERAL.exec(args[2]);
            site.method = name ? name[2] : null;
            const els = args[3][0] === '[' ? splitList(args[3], 0) : null;
            site.context = els ? els.length : null;
        }
        sites.push(site);
    }
    return sites;
}

function npmTestRunsPreflight() {
    assert.ok(testScriptSpecs().includes(PREFLIGHT), 'package.json scripts.test no longer runs ' + PREFLIGHT);
}
function preflightRunsFirst() {
    assert.strictEqual(testScriptSpecs()[0], PREFLIGHT, 'the preflight must be the first spec in scripts.test');
}

function ciRunsPreflight() {
    const ci = String(PKG.scripts.ci || '');
    assert.ok(/ci-preflight\.js/.test(ci), 'scripts.ci must run bin/ci-preflight.js');
    assert.ok(ci.indexOf('ci-preflight.js') < ci.indexOf('npm test'),
        'bin/ci-preflight.js must run BEFORE npm test in scripts.ci');
}

function preflightNeverSkips() {
    const code = read(PREFLIGHT).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/describe\.skip|it\.skip|this\.skip\(/.test(code), PREFLIGHT + ' must fail on an unloadable harness, never skip');
    assert.ok(!/\bcatch\s*\(/.test(code), PREFLIGHT + ' must not swallow a require failure in a catch block');
}

function listedSpecsExist() {
    none(testScriptSpecs().filter(spec => !fs.existsSync(path.join(REPO_DIR, spec))),
        'scripts.test names spec files that do not exist: ');
}
function everyTestFileIsGated() {
    const listed = new Set(testScriptSpecs());
    none(discoverTestFiles(REPO_DIR).filter(f => !listed.has(f)),
        'these *.test.js files are not in scripts.test, so `npm test` never runs them: ');
}

function skippingSuitesAreGated() {
    const listed = new Set(testScriptSpecs());
    none(discoverTestFiles(REPO_DIR).filter(f => /describe\.skip/.test(read(f)) && !listed.has(f)),
        'these suites can silently become pending and are not in scripts.test: ');
}

function templatesHaveSuites() {
    const templates = discoverTemplates();
    assert.ok(templates.length > 0, 'template discovery found nothing; the <name>/<name>.js predicate has drifted');
    none(templates.filter(n => !fs.existsSync(suitePath(n))),
        'these templates are linted but have no suite, so their VM coverage is imaginary: ');
}

function abiProblem(mod) {
    const abi = mod && mod.abi;
    if (!abi || typeof abi !== 'object') return 'no abi block';
    if (abi.version !== 1) return 'abi.version is not 1';
    if (!abi.methods || typeof abi.methods !== 'object' || Object.keys(abi.methods).length === 0)
        return 'abi.methods is missing or empty';
    return null;
}

function templatesDeclareAbi() {
    none(templateOffenders(abiProblem), 'these templates ship with no usable display metadata: ');
}

// ABI_PARAM_TYPES copies the type table in xchain-documentation/protocol/contract-abi.md,
// the source of truth; the platform root's param-type parity gate reads this literal, so keep it inline.
function paramProblem(el) {
    const ABI_PARAM_TYPES = ['string', 'number', 'amount', 'address', 'tick', 'bool', 'json'];
    if (!el || typeof el !== 'object' || Array.isArray(el)) return 'not an object literal';
    if (typeof el.name !== 'string' || el.name.length === 0) return 'no string name';
    if (ABI_PARAM_TYPES.indexOf(el.type) === -1) return 'type ' + JSON.stringify(el.type) + ' is not an allowed abi param type';
    return null;
}

function abiParamsAreObjects() {
    const offenders = [];
    for (const name of discoverTemplates()) {
        const loaded = loadTemplate(name);
        if (loaded.err) { offenders.push(name + ' (does not load: ' + loaded.err.message + ')'); continue; }
        for (const [method, spec] of Object.entries(abiMethods(loaded.mod))) {
            const params = spec && spec.params;
            if (params === undefined) continue;
            if (!Array.isArray(params)) { offenders.push(name + '.' + method + ' (params is not an array)'); continue; }
            params.forEach((el, i) => { const why = paramProblem(el); if (why) offenders.push(name + '.' + method + '[' + i + '] (' + why + ')'); });
        }
    }
    none(offenders, 'the abi readers drop the whole method entry for each of these: ');
}

// Unlike abi, `meta` is NOT advisory: under CONTRACT_META_REQUIRED the indexer refuses a
// DEPLOY lacking name or description, which the E2E harness never exercises.
function metaProblem(mod) {
    const meta = mod && mod.meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return 'no meta block';
    if (typeof meta.name !== 'string' || meta.name.length === 0) return 'meta.name is missing or empty';
    if (typeof meta.description !== 'string' || meta.description.length === 0) return 'meta.description is missing or empty';
    if (meta.version !== undefined && typeof meta.version !== 'string') return 'meta.version is present but not a string';
    return null;
}

function templatesDeclareMeta() {
    none(templateOffenders(metaProblem),
        'consensus rejects a DEPLOY of these templates ("invalid: CONTRACT_MANIFEST (meta required)"): ');
}
function metaIsFirstKey() {
    none(offendersOverLoaded((name, mod, out) => {
        if (Object.keys(mod)[0] !== 'meta') out.push(name + ' (first key is ' + JSON.stringify(Object.keys(mod)[0]) + ')');
    }), 'meta must be the first key of module.exports, above abi: ');
}

function suitesDeployThroughVm() {
    const offenders = [];
    for (const name of discoverTemplates()) {
        const spec = suitePath(name);
        if (!fs.existsSync(spec)) continue;   // named by the suite check above
        const src = blankComments(fs.readFileSync(spec, 'utf8'));
        const bootsVm = /E2EHarness/.test(src) || /e2e[\/\\]helpers[\/\\]harness/.test(src);
        if (!bootsVm || !/\.deploy\s*\(/.test(src)) offenders.push(name);
    }
    none(offenders, 'these template suites never deploy through the E2E harness, so they are lint-only: ');
}

function patternHelpers(dir, f) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    return [...src.matchAll(/^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm)].map(m => m[1]);
}

function helperNameClashes(dir, files) {
    const seen    = new Map();
    const clashes = [];
    for (const f of files) {
        for (const fn of patternHelpers(dir, f)) {
            if (seen.has(fn)) clashes.push(fn + ' (' + seen.get(fn) + ' vs ' + f + ')');
            else seen.set(fn, f);
        }
    }
    return clashes;
}

// Patterns are not <name>/<name>.js, so the template checks skip them; only
// patterns/patterns.e2e.test.js runs them through the VM. Per HELPER, not per file.
function patternsAreCalledByVault() {
    const dir   = path.join(REPO_DIR, 'patterns');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.js') && !f.endsWith('.test.js')).sort();
    assert.ok(files.length > 0, 'pattern discovery found nothing; this guard is now inert');
    none(helperNameClashes(dir, files), 'these helper names are declared in more than one pattern file: ');
    const e2e = deployedContractCode(fs.readFileSync(path.join(dir, 'patterns.e2e.test.js'), 'utf8'));
    none(files.filter(f => patternHelpers(dir, f).length === 0),
        'these pattern sources declare no top-level helper, so this guard is inert for them: ');
    const uncalled = [];
    for (const f of files)
        for (const fn of patternHelpers(dir, f)) if (!callsHelper(e2e, fn)) uncalled.push(f + ':' + fn);
    none(uncalled, 'these pattern helpers are never called in any contract patterns.e2e.test.js deploys: ');
}

function commentMentionIsNotACall() {
    const contract = (body) => '// see requireFoo(xchain) below\n' +
        'const C = HELPERS + `\nmodule.exports = { m: function (xchain) {\n' +
        '    // requireFoo(xchain) runs here\n    /* requireFoo(xchain) */\n' + body + '} };`;\n';
    assert.strictEqual(callsHelper(deployedContractCode(contract('')), 'requireFoo'), false,
        'a comment-only mention of requireFoo read as a call site');
    assert.strictEqual(callsHelper(deployedContractCode(contract('    requireFoo(xchain);\n')), 'requireFoo'), true,
        'a real requireFoo call inside the deployed contract was not found');
}

describe('gate wiring: the preflight cannot be dropped silently', function () {
    it('`npm test` runs the preflight', npmTestRunsPreflight);
    it('the preflight runs FIRST, so the failure heads the report', preflightRunsFirst);
    it('`npm run ci` still runs the standalone preflight before the suites', ciRunsPreflight);
    it('the preflight itself can never degrade to a skip', preflightNeverSkips);
    it('every spec listed in scripts.test exists on disk', listedSpecsExist);
    it('every test file in the repo is inside the gated run', everyTestFileIsGated);
    it('every suite that degrades to describe.skip is inside the gated run', skippingSuitesAreGated);
    it('every discovered template has an adjacent test suite', templatesHaveSuites);
    it('every discovered template declares an advisory abi block', templatesDeclareAbi);
    it('every abi method declares its params as { name, type } object literals', abiParamsAreObjects);
    it('every discovered template declares a consensus-required meta block', templatesDeclareMeta);
    it('every discovered template declares meta as the first exported key', metaIsFirstKey);
    it('every template suite deploys its template through the real VM', suitesDeployThroughVm);
    it('every pattern source contributes a helper the VM-deployed vault calls', patternsAreCalledByVault);
    it('a helper named only in a comment does not read as called', commentMentionIsNotACall);
});

// The checks below read a template against the CALLER: the indexer fires attestation
// callbacks with a four-slot preamble the contract never names. Arity is derived from
// the injector's rule (4 + the registered context array), never from the getInputParam
// indices the body reads: a callback reading only slot 0 passes any reads-derived scan.

function scanFindsRegistrations() {
    const found = [];
    for (const name of discoverTemplates())
        for (const site of callbackRegistrations(tplSrc(name))) found.push(name + '.' + site.method);
    const list = ' Found: ' + found.join(', ');
    assert.ok(found.length >= 3, 'the attestation.request() scan found ' + found.length + ' call sites: the parser has broken.' + list);
    assert.ok(found.indexOf('urlOracle.onPrice') !== -1, 'the scan no longer sees urlOracle.onPrice; comment blanking has regressed.' + list);
    assert.ok(found.indexOf('counterpartyBridge.onClaim') !== -1, 'the scan no longer sees counterpartyBridge.onClaim.' + list);
}

function siteProblem(site) {
    if (!site.args) return 'argument list does not close';
    if (site.args.length < 4) return 'only ' + site.args.length + ' arguments; the callback method and context array are required';
    if (!site.method) return 'callback method is not a plain string literal, so its abi entry cannot be located';
    if (site.context === null) return 'context is not an array literal, so the callback arity cannot be derived';
    return null;
}

function registrationsAreParseable() {
    const offenders = [];
    for (const name of discoverTemplates()) {
        callbackRegistrations(tplSrc(name)).forEach(function (site, i) {
            const why = siteProblem(site);
            if (why) offenders.push(name + ' attestation.request()#' + i + ' (' + why + ')');
        });
    }
    none(offenders, 'these attestation registrations cannot be read statically, so the callback ships uncertified: ');
}

function arityProblem(mod, site) {
    if (typeof mod[site.method] !== 'function') return 'registered as a callback but not exported, so the injected EXECUTE reverts';
    const spec = abiMethods(mod)[site.method];
    if (!spec) return 'registered as a callback with no abi entry';
    if (!Array.isArray(spec.params)) return 'abi params is not an array';
    const expected = PREAMBLE.length + site.context;
    if (spec.params.length === expected) return null;
    return 'declares ' + spec.params.length + ' param(s); the injector sends ' + expected + ' (preamble plus ' + site.context + ' context)';
}

function callbacksDeclareFullArity() {
    none(offendersOverLoaded(function (name, mod, out) {
        for (const site of callbackRegistrations(tplSrc(name))) {
            if (!site.method || site.context === null) continue;   // named by the previous test
            const why = arityProblem(mod, site);
            if (why) out.push(name + '.' + site.method + ' (' + why + ')');
        }
    }), 'the indexer sends [request_id, provider_id, status, response_payload, ...context] ' +
        '(attest/index.js injectCallbackExecute); these abi signatures are wrong on the wire: ');
}

function slotProblems(at, slot, el) {
    if (!el || typeof el !== 'object') return [at + ' (missing; expected ' + slot.name + ')'];
    const out = [];
    if (el.name !== slot.name) out.push(at + ' (named ' + JSON.stringify(el.name) + ', the injector puts ' + slot.name + ' here)');
    if (slot.type && el.type !== slot.type) out.push(at + ' (type ' + JSON.stringify(el.type) + '; the indexer always sends ' + slot.type + ' here)');
    return out;
}

function callbacksNamePreambleSlots() {
    none(offendersOverLoaded(function (name, mod, out) {
        for (const site of callbackRegistrations(tplSrc(name))) {
            if (!site.method) continue;
            const params = (abiMethods(mod)[site.method] || {}).params;
            if (!Array.isArray(params)) continue;   // named above
            PREAMBLE.forEach(function (slot, i) {
                out.push(...slotProblems(name + '.' + site.method + '[' + i + ']', slot, params[i]));
            });
        }
    }), 'the preamble slots arrive in a fixed order; these document a wire that does not exist: ');
}

// The inverse, keyed on behaviour: a method that reads an attestation response is one the
// injector fires (treasury.arm is a POLL callback with a longer wire, pinned in
function responseReadersAreRegistered() {
    none(offendersOverLoaded(function (name, mod, out) {
        const registered = new Set(callbackRegistrations(tplSrc(name)).map(s => s.method).filter(Boolean));
        for (const [method, fn] of Object.entries(mod)) {
            if (typeof fn !== 'function') continue;
            if (!/xchain\s*\.\s*attestation\s*\.\s*getResponse\s*\(/.test(blankComments(String(fn)))) continue;
            if (!registered.has(method)) out.push(name + '.' + method);
        }
    }), 'these methods consume an attestation response but no attestation.request() registers them: ');
}

describe('attestation callbacks: arity is the injector\'s, not the contract\'s reads', function () {
    it('the scan actually finds the registrations that exist', scanFindsRegistrations);
    it('every registration is parseable, so no callback escapes certification', registrationsAreParseable);
    it('every registered callback declares the full injector arity in its abi', callbacksDeclareFullArity);
    it('every registered callback names the preamble slots in injector order', callbacksNamePreambleSlots);
    it('every method that reads an attestation response is registered as a callback', responseReadersAreRegistered);
});
