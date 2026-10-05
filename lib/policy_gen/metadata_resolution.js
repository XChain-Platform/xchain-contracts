// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND. See the MIT License for the full text.

'use strict';

const {
    META_TEXT_RE,
    META_NAME_MAX,
    META_DESCRIPTION_MAX,
    META_VERSION_MAX
} = require('./constants');
const { isPlainObject, assert } = require('./validation_helpers');

// Validate one meta text field against the narrowed grammar above, with the message
// naming the field and its cap so a config author can fix it without reading this file.
function assertMetaText(value, field, maxBytes) {
    assert(typeof value === 'string' && value.length <= maxBytes && META_TEXT_RE.test(value),
        'meta.' + field + ' must be 1 to ' + maxBytes + ' printable ASCII characters with no ' +
        'leading or trailing space');
}

// The generated description: an honest one-liner naming what the guard actually
// enforces, so a wallet or explorer showing it is showing the policy, not a label.
// Every branch is reachable (validateConfig has already asserted at least one rule),
// and the longest possible sentence is far inside the 512-byte cap.
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

// Merge a caller's meta over the generated defaults, field by field.
function resolveMeta(rawMeta, cfg) {
    // cfg.name is a header label whose own gate (NAME_RE) tolerates edge spaces, which
    // the meta grammar refuses. Trim the DERIVED default rather than reject: a config
    // that generated a clean guard before this key existed must keep generating one.
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
