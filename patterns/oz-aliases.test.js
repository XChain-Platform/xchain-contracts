// SPDX-License-Identifier: MIT
//
// Integrity gate for the OpenZeppelin -> XChain alias map (oz-aliases.json).
// The map is consumed by the docs and the Solidity-to-XChain on-ramp tooling,
// so a helper it names must actually exist as a top-level function in the file
// it points at (otherwise a dev following the alias hits a dead reference).
// Pure fs/regex, runs on any Node.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js patterns/oz-aliases.test.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const ALIASES = JSON.parse(fs.readFileSync(path.join(DIR, 'oz-aliases.json'), 'utf8'));

// Extract the set of top-level `function name(...)` declarations from a pattern
// file (the paste-in helpers). Matches the same shape the README documents.
function topLevelFns(file) {
    const src = fs.readFileSync(path.join(DIR, file), 'utf8');
    const out = new Set();
    const re = /^function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gm;
    let m;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
    return out;
}

describe('oz-aliases.json integrity', function () {

    it('is a versioned object with an aliases array', function () {
        assert.strictEqual(typeof ALIASES.version, 'string');
        assert.ok(Array.isArray(ALIASES.aliases) && ALIASES.aliases.length > 0);
    });

    it('every alias names an OZ symbol', function () {
        for (const a of ALIASES.aliases) {
            assert.ok(typeof a.oz === 'string' && a.oz.length > 0, 'alias missing oz name');
            assert.ok(Array.isArray(a.helpers), a.oz + ': helpers must be an array');
            assert.ok(typeof a.note === 'string' && a.note.length > 0, a.oz + ': note required');
        }
    });

    it('every referenced pattern file exists', function () {
        for (const a of ALIASES.aliases) {
            if (a.file === null) continue; // "not needed" / native-action rows carry no file
            assert.ok(fs.existsSync(path.join(DIR, a.file)), a.oz + ' -> missing file ' + a.file);
        }
    });

    it('every listed helper is a real top-level function in its file', function () {
        const cache = {};
        for (const a of ALIASES.aliases) {
            if (a.file === null) {
                assert.strictEqual(a.helpers.length, 0, a.oz + ': null file must list no helpers');
                continue;
            }
            const fns = cache[a.file] || (cache[a.file] = topLevelFns(a.file));
            for (const h of a.helpers) {
                assert.ok(fns.has(h), a.oz + ' -> ' + a.file + ' has no helper "' + h + '"');
            }
        }
    });

    it('README documents the OpenZeppelin mapping and links the JSON', function () {
        const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
        assert.ok(/OpenZeppelin/.test(readme), 'README must mention OpenZeppelin');
        assert.ok(/oz-aliases\.json/.test(readme), 'README must link oz-aliases.json');
    });

    // The README table is the human form of the JSON and the README says so, so the
    // two row sets are pinned to each other in both directions: a JSON alias with no
    // table row, or a table row with no alias, fails here by name.
    it('the README OZ table and the JSON carry the same set of OZ names', function () {
        const lines = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8').split('\n');
        const header = lines.indexOf('| OpenZeppelin | XChain equivalent | Where |');
        assert.notStrictEqual(header, -1, 'README OZ table header not found; the table was renamed or removed');
        const rows = [];
        for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
        assert.ok(rows.length > 0, 'README OZ table has no rows');
        // Names render with backticks in the table and plain in the JSON.
        const tableNames = rows.map(r => r.split('|')[1].replace(/`/g, '').trim()).sort();
        const jsonNames = ALIASES.aliases.map(a => a.oz).sort();
        assert.deepStrictEqual(tableNames, jsonNames,
            'README OZ table rows and oz-aliases.json aliases differ; add the missing row or alias');
    });

});

// A row's helpers can call helpers defined in OTHER pattern files, and a single-file
// paste of the row alone then throws a ReferenceError at run time. Derive those calls.
describe('oz-aliases.json cross-file requires', function () {

    const HOME = new Map();
    for (const f of fs.readdirSync(DIR).filter(n => n.endsWith('.js') && !n.endsWith('.test.js')))
        for (const fn of topLevelFns(f)) HOME.set(fn, f);

    // Body of a top-level helper through its column-0 closing brace, line comments removed.
    function helperBody(file, name) {
        const src = fs.readFileSync(path.join(DIR, file), 'utf8');
        const start = src.indexOf('\nfunction ' + name + '(');
        const end = src.indexOf('\n}\n', start);
        assert.ok(start !== -1 && end !== -1, name + ' has no top-level body in ' + file);
        return src.slice(start + 1, end + 3).replace(/\/\/.*$/gm, '');
    }

    // Collect every 'file:helper' outside the row's file reachable from its helpers.
    function derivedRequires(row) {
        const seen = new Set(row.helpers.map(h => row.file + ':' + h));
        const queue = row.helpers.map(h => [row.file, h]);
        const out = new Set();
        while (queue.length > 0) {
            const [file, name] = queue.shift();
            const body = helperBody(file, name);
            for (const [callee, home] of HOME) {
                if (callee === name || !new RegExp('\\b' + callee + '\\s*\\(').test(body)) continue;
                const key = home + ':' + callee;
                if (home !== row.file) out.add(key);
                if (!seen.has(key)) { seen.add(key); queue.push([home, callee]); }
            }
        }
        return [...out].sort();
    }

    it('every requires entry names real helpers in another existing pattern file', function () {
        for (const a of ALIASES.aliases) {
            if (a.requires === undefined) continue;
            assert.notStrictEqual(a.file, null, a.oz + ': a null-file row cannot require helpers');
            assert.ok(Array.isArray(a.requires), a.oz + ': requires must be an array');
            for (const r of a.requires) {
                assert.ok(typeof r.file === 'string' && r.file !== a.file, a.oz + ': requires must name another file');
                assert.ok(fs.existsSync(path.join(DIR, r.file)), a.oz + ' requires missing file ' + r.file);
                assert.ok(Array.isArray(r.helpers) && r.helpers.length > 0, a.oz + ': requires.helpers must be non-empty');
                for (const h of r.helpers) assert.ok(topLevelFns(r.file).has(h), a.oz + ' requires unknown ' + r.file + ':' + h);
            }
        }
    });

    it('every row declares exactly the cross-file helpers its helpers call', function () {
        for (const a of ALIASES.aliases) {
            if (a.file === null) continue;
            const declared = [];
            for (const r of a.requires || []) for (const h of r.helpers) declared.push(r.file + ':' + h);
            assert.deepStrictEqual(declared.sort(), derivedRequires(a),
                a.oz + ': requires differs from the cross-file calls in its helpers (missing or stale entry)');
        }
    });
});

// Pin the ERC2981 royalty claim to the generator's royalty-scope disclosure
// (lib/policy-gen.js royaltyScopeNotes), since Solidity readers land on this row first.
describe('oz-aliases.json ERC2981 royalty note', function () {

    it('the ERC2981 note scopes the royalty to ORDER/SWAP and names the dispenser gap', function () {
        const row = ALIASES.aliases.find(a => a.oz.startsWith('ERC2981'));
        assert.ok(row, 'oz-aliases.json has no ERC2981 alias');
        assert.ok(!/every transfer|cannot be bypassed/i.test(row.note),
            'ERC2981 note overclaims: the split covers ORDER/SWAP proceeds only and dispensers route around it');
        for (const needle of ['ORDER_CREATE', 'SWAP_CREATE', 'DISPENSER_CREATE', 'CROSS_CHAIN_ROYALTY', 'controller-bound-tokens.md']) {
            assert.ok(row.note.includes(needle), 'ERC2981 note must mention ' + needle);
        }
    });

});
