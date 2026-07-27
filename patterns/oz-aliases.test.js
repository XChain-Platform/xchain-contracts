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

});
