// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// policy-gen.js: the Tier 0 no-code token-policy generator.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.

'use strict';

const {
    ACTION_CLASSES,
    BINDABLE_CLASSES,
    MAX_BPS,
    PROTOCOL_MAX_TAKE_BPS
} = require('./policy_gen/constants');
const { validateConfig } = require('./policy_gen/config-validation');
const { emitSource } = require('./policy_gen/source-emission');
const { bindHints } = require('./policy_gen/bind-hints');

function generatePolicy(rawConfig) {
    const cfg = validateConfig(rawConfig);
    return {
        source: emitSource(cfg),
        bindHints: bindHints(cfg),
        gates: cfg.gates.slice(),
        features: {
            pausable: cfg.pausable,
            freeze: cfg.freeze !== null,
            allowlist: cfg.allowlist !== null,
            allowlistDirection: cfg.allowlistDirection,
            royalty: cfg.royalty !== null,
            maxTakeBps: cfg.maxTakeBps,
            permissions: cfg.permissions
        }
    };
}

module.exports = {
    generatePolicy,
    validateConfig,
    ACTION_CLASSES,
    BINDABLE_CLASSES,
    MAX_BPS,
    PROTOCOL_MAX_TAKE_BPS
};
