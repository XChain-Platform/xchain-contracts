// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// policy-gen.js: the Tier 0 no-code token-policy generator.
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND. See the MIT License for the full text.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// Most people who reach for a smart contract actually want a *token with rules*
// (royalties, transfer restrictions, a pause switch) and never want to write a
// line of contract code. This module turns a small declarative policy config
// into a deploy-ready controller guard contract: the "no-language path for the
// common 80%" (Tier 0 of the developer on-ramp proposal).
//
// A controller guard is a normal XChain contract with a `guard` method that the
// indexer runs BEFORE a gated native action (transfer/trade/burn/mint/stake)
// settles. The guard either allows the action (returns), routes a proceeds split
// (returns { payoutLegs }), or blocks it (xchain.revert). A token binds its
// action classes to the deployed guard via ISSUE v6. An account may bind via
// ADDRESS v1, but the indexer runs an account's guard for `transfer` only (see
// accountBindNotes). See xchain-documentation/protocol/controller-bound-tokens.md.
//
// The generated source is deliberately built to pass the deploy-time linter with
// ZERO errors and ZERO warnings: input reads live in hoisted helpers (so the
// guard body itself trips no missing-input-validation warning), every state.get
// is null-guarded, all numbers are integers, and there are no banned globals.
// ---------------------------------------------------------------------------

'use strict';

const {
    ACTION_CLASSES,
    BINDABLE_CLASSES,
    MAX_BPS,
    PROTOCOL_MAX_TAKE_BPS
} = require('./policy_gen/constants');
const { validateConfig } = require('./policy_gen/config_validation');
const { emitSource } = require('./policy_gen/source_emission');
const { bindHints } = require('./policy_gen/bind_hints');

// ---------------------------------------------------------------------------
// Public API: config -> { source, bindHints, gates, features }.
// Throws Error (message prefixed "policy config: ") on an invalid config.
// ---------------------------------------------------------------------------
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
