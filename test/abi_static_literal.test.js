// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// abi_static_literal.test.js: every template abi block is the static literal readers parse.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Wallets and explorers never run contract code: they parse the source and keep only
// literal nodes (xchain-documentation/protocol/contract-abi.md, "static literal").
// The gate-wiring abi tests check the require()d value instead, which an identifier,
// a call or a computed key satisfies just as well, so this file checks the source.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/abi_static_literal.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_DIR = path.join(__dirname, '..');
const VM_DIR   = path.join(REPO_DIR, '..', 'xchain-vm');

// Load the VM's own parser and dialect with no fallback, so a missing VM fails here and never skips.
const acorn = require(require.resolve('acorn', { paths: [VM_DIR] }));
const { CONTRACT_ECMA_VERSION } = require(path.join(VM_DIR, 'src', 'metering.js'));

// Same <name>/<name>.js predicate as gate-wiring.test.js discoverTemplates().
function discoverTemplates() {
    return fs.readdirSync(REPO_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name !== 'node_modules' && !e.name.startsWith('.'))
        .map(e => e.name)
        .filter(n => fs.existsSync(path.join(REPO_DIR, n, n + '.js')))
        .sort();
}

// Return the `abi` property node of the module.exports object literal, or null.
function abiNode(source) {
    const ast = acorn.parse(source, { ecmaVersion: CONTRACT_ECMA_VERSION, sourceType: 'script' });
    for (const stmt of ast.body) {
        const e = stmt.type === 'ExpressionStatement' ? stmt.expression : null;
        const isExports = e && e.type === 'AssignmentExpression' && e.left.type === 'MemberExpression'
            && !e.left.computed && e.left.object.name === 'module' && e.left.property.name === 'exports';
        if (!isExports || e.right.type !== 'ObjectExpression') continue;
        const prop = e.right.properties.find(p => p.type === 'Property' && !p.computed
            && (p.key.name || p.key.value) === 'abi');
        return prop ? prop.value : null;
    }
    return null;
}

// Evaluate a pure-literal node, pushing an offender for any node a reader would not keep.
function literalValue(node, where, offenders) {
    if (node.type === 'Literal' && !node.regex && node.bigint === undefined) return node.value;
    if (node.type === 'ArrayExpression') {
        return node.elements.map((el, i) => el && el.type !== 'SpreadElement'
            ? literalValue(el, where + '[' + i + ']', offenders)
            : offenders.push(where + '[' + i + '] (hole or spread)'));
    }
    if (node.type === 'ObjectExpression') {
        const out = {};
        for (const p of node.properties) {
            const plain = p.type === 'Property' && !p.computed && p.kind === 'init' && !p.method && !p.shorthand;
            const key = plain && (p.key.type === 'Identifier' ? p.key.name : (typeof p.key.value === 'string' ? p.key.value : null));
            if (!key) { offenders.push(where + ' (computed, spread, method or shorthand property)'); continue; }
            out[key] = literalValue(p.value, where + '.' + key, offenders);
        }
        return out;
    }
    offenders.push(where + ' (' + node.type + ' is not a literal)');
    return undefined;
}

describe('template abi blocks match what source-reading wallets and explorers see', function () {

    it('every template abi block is a pure static literal equal to the evaluated block', function () {
        const templates = discoverTemplates();
        assert.ok(templates.length > 0, 'template discovery found nothing, so this guard is inert');
        const offenders = [];
        for (const name of templates) {
            const file = path.join(REPO_DIR, name, name + '.js');
            const node = abiNode(fs.readFileSync(file, 'utf8'));
            if (!node) { offenders.push(name + ' (no abi property in the module.exports literal)'); continue; }
            const before = offenders.length;
            const parsed = literalValue(node, name + '.abi', offenders);
            if (offenders.length > before) continue;
            try {
                assert.deepStrictEqual(parsed, require(file).abi);
            } catch (err) {
                offenders.push(name + ' (the parsed literal differs from the evaluated abi block)');
            }
        }
        assert.deepStrictEqual(offenders, [],
            'readers drop or null these abi entries, so wallets and explorers show the methods bare or not at all: ' +
            offenders.join(', '));
    });

    it('every abi.methods key names an exported function and initialize is never listed', function () {
        const offenders = [];
        for (const name of discoverTemplates()) {
            const mod = require(path.join(REPO_DIR, name, name + '.js'));
            for (const method of Object.keys((mod.abi && mod.abi.methods) || {})) {
                if (method === 'initialize') offenders.push(name + '.initialize (constructor listed in abi.methods)');
                else if (typeof mod[method] !== 'function') offenders.push(name + '.' + method + ' (no exported function)');
            }
        }
        assert.deepStrictEqual(offenders, [],
            'these abi.methods entries advertise a callable method the contract does not expose: ' + offenders.join(', '));
    });
});
