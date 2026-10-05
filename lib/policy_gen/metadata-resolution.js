// SPDX-License-Identifier: MIT

'use strict';

const {
    META_TEXT_RE,
    META_NAME_MAX,
    META_DESCRIPTION_MAX,
    META_VERSION_MAX
} = require('./constants');
const { isPlainObject, assert } = require('./validation-helpers');

function assertMetaText(value, field, maxBytes) {
    assert(typeof value === 'string' && value.length <= maxBytes && META_TEXT_RE.test(value),
        'meta.' + field + ' must be 1 to ' + maxBytes + ' printable ASCII characters with no ' +
        'leading or trailing space');
}

function defaultMetaDescription(cfg) {
    const rules = [];
    if (cfg.pausable) rules.push('an owner pause switch');
    if (cfg.freeze !== null) rules.push('a per-account freeze list');
    if (cfg.allowlist !== null) rules.push('a ' + cfg.allowlistDirection + '-side allowlist');
    if (cfg.royalty !== null) rules.push('a royalty split on trade-class actions');
    const last = rules.pop();
    const ruleText = rules.length ? rules.join(', ') + ' and ' + last : last;
    return 'Generated controller guard for the ' + cfg.gates.join('/') + ' action ' +
        (cfg.gates.length === 1 ? 'class' : 'classes') + ', enforcing ' + ruleText + '.';
}

function resolveMeta(rawMeta, cfg) {
    const meta = {
        name: cfg.name.trim() || 'TokenPolicy',
        description: defaultMetaDescription(cfg),
        version: '1.0.0'
    };
    if (rawMeta !== undefined && rawMeta !== null) {
        assert(isPlainObject(rawMeta), 'meta must be an object');
        for (const field of ['name', 'description', 'version']) {
            if (rawMeta[field] === undefined || rawMeta[field] === null) continue;
            meta[field] = rawMeta[field];
        }
    }
    assertMetaText(meta.name, 'name', META_NAME_MAX);
    assertMetaText(meta.description, 'description', META_DESCRIPTION_MAX);
    assertMetaText(meta.version, 'version', META_VERSION_MAX);
    return meta;
}

module.exports = { resolveMeta };
