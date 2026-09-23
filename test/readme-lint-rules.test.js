// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// readme-lint-rules.test.js: the README's lint rule list tracks the VM linter.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The "Linting" section of README.md is the only place in this repo that tells an
// author which rules `xchain-contracts lint` blocks on. The rules live in
// xchain-vm's lint core, so a rule added there leaves the README telling authors
// that `async`, generators or rest parameters are fine until the CLI refuses them.
// This file reads the deploy-blocking set and the code-size cap from the lint core
// itself and fails when the README section stops naming one of them.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/readme-lint-rules.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_DIR = path.join(__dirname, '..');
const README   = fs.readFileSync(path.join(REPO_DIR, 'README.md'), 'utf8');

// Try both spellings of xchain-vm's lint core, as lib/policy-gen.test.js does.
const LINT_CORE_SPELLINGS = [path.join(REPO_DIR, '..', 'xchain-vm', 'src', 'lint_core.js'),
                             path.join(REPO_DIR, '..', 'xchain-vm', 'src', 'lint-core.js')];

// Load the lint core, failing rather than skipping: xchain-vm is a declared sibling.
function loadLintCore() {
    for (const spec of LINT_CORE_SPELLINGS) {
        try { return require(spec); }
        catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
    }
    throw new Error('xchain-vm lint core not found beside this repo (tried ' +
        LINT_CORE_SPELLINGS.join(', ') + '); this guard cannot run without it');
}

// Return the README's "## Linting" section, up to the next level-2 heading.
function lintingSection() {
    const start = README.indexOf('\n## Linting\n');
    assert.ok(start >= 0, 'README.md has no "## Linting" section for this guard to check');
    const next = README.indexOf('\n## ', start + 1);
    return next < 0 ? README.slice(start) : README.slice(start, next);
}

describe('README lint rule list', function () {

    it('names every deploy-blocking rule in the VM lint core', function () {
        const { CONSENSUS_RULES } = loadLintCore();
        assert.ok(CONSENSUS_RULES instanceof Set && CONSENSUS_RULES.size > 0,
            'xchain-vm lint core exports no CONSENSUS_RULES set, so this guard would check nothing');
        const section = lintingSection();
        const missing = [...CONSENSUS_RULES].filter(rule => !section.includes('`' + rule + '`'));
        assert.deepStrictEqual(missing, [],
            'README.md "Linting" omits deploy-blocking rules the linter enforces: ' +
            missing.join(', ') + '. Name each one as a code span beside a short gloss.');
    });

    it('names the code-size rule and its byte cap', function () {
        const { MAX_CODE_SIZE } = loadLintCore();
        assert.ok(Number.isInteger(MAX_CODE_SIZE) && MAX_CODE_SIZE > 0,
            'xchain-vm lint core exports no MAX_CODE_SIZE, so this guard would check nothing');
        const section = lintingSection();
        assert.ok(section.includes('`code-size`'),
            'README.md "Linting" does not name the `code-size` rule the linter enforces');
        assert.ok(section.includes(MAX_CODE_SIZE.toLocaleString('en-US')),
            'README.md "Linting" does not state the ' + MAX_CODE_SIZE + '-byte code-size cap');
    });
});
