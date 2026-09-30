'use strict';

// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

// Companion to dependency-advisories.test.js, and deliberately NOT part of it:
// that file is byte-identical across every sibling repo that carries it, while
// this hazard is specific to a file: dependency's own recorded snapshot.
//
// package-lock.json freezes a copy of each file: sibling's manifest under its
// path key. npm only re-resolves that copy when the entry is absent, so a
// version bump on the sibling side (xchain-vm/package.json) does not by
// itself touch the lockfile: an `npm ci` will not see it either, since `npm
// ci` trusts the lock and never re-reads a file: link's manifest. Only a real
// `npm install` re-reads the sibling and writes its current version back in.
// Until that install runs, the two numbers can drift apart silently, because
// nothing else resolves differently while both sides still agree on the
// dependency range itself.
describe('Security: staged sibling trees carry no vulnerable copies @regression @tier4', function () {
    const root = (function () {
        let dir = __dirname;
        while (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
            const up = path.dirname(dir);
            if (up === dir) throw new Error(`no package-lock.json above ${__dirname}`);
            dir = up;
        }
        return dir;
    })();
    const pkg  = require(path.join(root, 'package.json'));
    const lock = require(path.join(root, 'package-lock.json'));

    // Every dependency declared as a local path. Read from package.json rather
    // than hardcoded so a second staged sibling is covered the day one is added.
    function stagedSiblings() {
        return Object.entries(pkg.dependencies || {})
            .filter(([, range]) => /^file:/.test(String(range)))
            .map(([name, range]) => ({
                name,
                dir: path.resolve(root, String(range).replace(/^file:/, ''))
            }));
    }

    const siblings = stagedSiblings();

    it('ADV-7: package.json still declares the staged siblings as local paths', function () {
        // Guards the premise rather than the hazard: if these stop being file:
        // dependencies the parity check below silently covers nothing, and
        // this suite would pass while proving less than it did yesterday.
        assert.ok(siblings.length > 0,
            'expected at least one file: dependency (xchain-vm)');
    });

    siblings.forEach(function (sibling) {
        it(`ADV-9: the lockfile snapshot of ${sibling.name} records the sibling repo's own version`, function () {
            const key  = path.relative(root, sibling.dir).split(path.sep).join('/');
            const snap = (lock.packages || {})[key];
            assert.ok(snap, `package-lock.json has no packages["${key}"] entry for the staged ${sibling.name}; `
                + 'the file: dependency layout changed and this guard needs re-pointing');
            assert.ok(typeof snap.version === 'string',
                `package-lock.json packages["${key}"] records no version for ${sibling.name}`);

            const manifestPath = path.join(sibling.dir, 'package.json');
            // The sibling tree is a live checkout, not a build artifact this repo
            // controls, so its manifest could theoretically go missing. That is
            // itself a fact this suite must report rather than swallow: skipping
            // here would let the parity check pass without ever comparing a
            // subject, which is exactly the silent-pass this file exists to rule out.
            assert.ok(fs.existsSync(manifestPath),
                `${path.relative(root, manifestPath)} does not exist; cannot verify the staged `
                + `${sibling.name} snapshot against a sibling that has no manifest`);

            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            assert.strictEqual(snap.version, manifest.version,
                `package-lock.json packages["${key}"] records ${sibling.name}@${snap.version}, but `
                + `${path.relative(root, manifestPath)} declares ${manifest.version}. The staged snapshot is `
                + 'frozen at a version the sibling no longer carries; run a real `npm install` (not `npm ci`) '
                + 'to refresh it.');
        });
    });
});
