// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// readme-version-badge.test.js: the README version badge tracks package.json.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// The shields.io version badge on line 7 of README.md is the only version
// statement on the library's front page, and README.md ships in the npm tarball,
// so the badge is what a public reader takes as the release they are looking at.
// It is a hardcoded string with no link to package.json, so a release bump that
// forgets it leaves the front page advertising an older library. That is not
// cosmetic here: the meta block every template exports is required at deploy
// under CONTRACT_META_REQUIRED, so a badge naming a release from before that
// block tells a reader the templates are undeployable when they are not.
//
// This file joins the two. It needs no VM, so it runs on every platform.
//
//   node ../xchain-vm/node_modules/mocha/bin/mocha.js test/readme-version-badge.test.js

'use strict';

const assert = require('assert');
const fs     = require('fs');
const path   = require('path');

const REPO_DIR = path.join(__dirname, '..');
const PKG      = JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8'));
const README   = fs.readFileSync(path.join(REPO_DIR, 'README.md'), 'utf8');

// Every shields.io version badge in the README, as the version string it shows.
// The badge path is `badge/version-<version>-<color>`, so the version runs to the
// last hyphen-separated segment.
function badgeVersions() {
    const out = [];
    const re = /img\.shields\.io\/badge\/version-([^/"\s]+)-[A-Za-z]+/g;
    let m;
    while ((m = re.exec(README)) !== null) out.push(m[1]);
    return out;
}

describe('README version badge', function () {

    it('the README carries exactly one version badge', function () {
        const found = badgeVersions();
        assert.strictEqual(found.length, 1,
            'README.md must carry exactly one shields.io version badge for this ' +
            'assertion to mean anything; found ' + found.length + ': ' + found.join(', '));
    });

    it('the badge shows the package.json version', function () {
        assert.strictEqual(badgeVersions()[0], PKG.version,
            'README.md advertises a different release than package.json. The badge is ' +
            'the front page of an npm-published, publicly cloned library, so a reader ' +
            'takes it as the version they get. Bump it in the same change as ' +
            'package.json and CHANGELOG.md.');
    });

    it('CHANGELOG.md records the version the badge shows', function () {
        const changelog = fs.readFileSync(path.join(REPO_DIR, 'CHANGELOG.md'), 'utf8');
        assert.ok(changelog.includes('## [' + PKG.version + ']'),
            'CHANGELOG.md has no released section for ' + PKG.version + ', so the badge ' +
            'and package.json name a release the changelog never describes');
    });
});
