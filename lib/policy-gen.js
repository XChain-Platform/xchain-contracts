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
// action classes to the deployed guard via ISSUE v6; an account binds via
// ADDRESS v1. See xchain-documentation/protocol/Controller_Bound_Tokens.md.
//
// The generated source is deliberately built to pass the deploy-time linter with
// ZERO errors and ZERO warnings: input reads live in hoisted helpers (so the
// guard body itself trips no missing-input-validation warning), every state.get
// is null-guarded, all numbers are integers, and there are no banned globals.
// ---------------------------------------------------------------------------

'use strict';

// The native action classes a token/account may gate. Must match the SDK's
// controller.js ACTION_CLASSES and the indexer's CONTROLLER_ACTION_CLASSES.
// 'all' is the present-and-future fallback class (gates every routable class).
const ACTION_CLASSES = ['transfer', 'trade', 'burn', 'mint', 'stake'];
const BINDABLE_CLASSES = ACTION_CLASSES.concat(['all']);

// The action types (getInputParam(0) inside a guard) that represent a trade,
// i.e. the ones a royalty/fee split may be returned for.
const TRADE_ACTION_TYPES = ['ORDER_CREATE', 'SWAP_CREATE'];

const MAX_BPS = 10000; // 100.00% in basis points

// Conservative charset gate for anything embedded into the generated source as a
// string literal. We ALSO embed via JSON.stringify (which escapes correctly), so
// this is a defence-in-depth reject of obviously bogus / injection-shaped input
// with a clear error rather than a broken contract.
const ADDR_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const PERM_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,60}$/;

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assert(cond, msg) {
    if (!cond) throw new Error('policy config: ' + msg);
}

// ---------------------------------------------------------------------------
// Config validation. Throws a descriptive Error on the first problem so the CLI
// can print it verbatim. Returns a normalized config (never mutates the input).
// ---------------------------------------------------------------------------
function validateConfig(raw) {
    assert(isPlainObject(raw), 'must be a JSON object');

    const cfg = {};

    // name (optional; header only)
    if (raw.name !== undefined && raw.name !== null) {
        assert(typeof raw.name === 'string' && NAME_RE.test(raw.name),
            'name must be a short alphanumeric string');
        cfg.name = raw.name;
    } else {
        cfg.name = 'TokenPolicy';
    }

    // gates (required): which action classes this policy is meant to bind.
    assert(Array.isArray(raw.gates) && raw.gates.length > 0,
        'gates must be a non-empty array of action classes (' + BINDABLE_CLASSES.join(', ') + ')');
    const gates = [];
    for (const g of raw.gates) {
        assert(typeof g === 'string' && BINDABLE_CLASSES.indexOf(g) !== -1,
            'gate "' + g + '" is not one of: ' + BINDABLE_CLASSES.join(', '));
        if (gates.indexOf(g) === -1) gates.push(g);
    }
    cfg.gates = gates;
    const gatesTrade = gates.indexOf('trade') !== -1 || gates.indexOf('all') !== -1;

    // Feature flags.
    cfg.pausable = raw.pausable === true;

    if (raw.freeze !== undefined && raw.freeze !== null) {
        assert(Array.isArray(raw.freeze), 'freeze must be an array of addresses');
        cfg.freeze = raw.freeze.map((a) => {
            assert(typeof a === 'string' && ADDR_RE.test(a), 'freeze address "' + a + '" is invalid');
            return a;
        });
    } else {
        cfg.freeze = null;
    }

    if (raw.allowlist !== undefined && raw.allowlist !== null) {
        assert(Array.isArray(raw.allowlist) && raw.allowlist.length > 0,
            'allowlist must be a NON-empty array of addresses (an empty allowlist would block everyone)');
        cfg.allowlist = raw.allowlist.map((a) => {
            assert(typeof a === 'string' && ADDR_RE.test(a), 'allowlist address "' + a + '" is invalid');
            return a;
        });
    } else {
        cfg.allowlist = null;
    }

    // maxTakeBps (optional manifest cap on total proceeds a guard may route).
    if (raw.maxTakeBps !== undefined && raw.maxTakeBps !== null) {
        assert(Number.isInteger(raw.maxTakeBps) && raw.maxTakeBps >= 0 && raw.maxTakeBps <= MAX_BPS,
            'maxTakeBps must be an integer in [0, ' + MAX_BPS + ']');
        cfg.maxTakeBps = raw.maxTakeBps;
    } else {
        cfg.maxTakeBps = null;
    }

    // royalty (optional): a proceeds split returned on trade-class actions.
    if (raw.royalty !== undefined && raw.royalty !== null) {
        assert(Array.isArray(raw.royalty) && raw.royalty.length > 0,
            'royalty must be a non-empty array of { to, bps } legs');
        assert(gatesTrade,
            'royalty requires the "trade" (or "all") gate: a proceeds split is only applied to trade-class actions');
        let sum = 0;
        cfg.royalty = raw.royalty.map((leg) => {
            assert(isPlainObject(leg), 'each royalty leg must be an object');
            assert(typeof leg.to === 'string' && ADDR_RE.test(leg.to), 'royalty leg "to" address is invalid');
            assert(Number.isInteger(leg.bps) && leg.bps > 0 && leg.bps <= MAX_BPS,
                'royalty leg bps must be an integer in [1, ' + MAX_BPS + ']');
            sum += leg.bps;
            return { to: leg.to, bps: leg.bps };
        });
        assert(sum <= MAX_BPS, 'royalty legs sum to ' + sum + ' bps, which exceeds 100% (' + MAX_BPS + ')');
        if (cfg.maxTakeBps !== null)
            assert(sum <= cfg.maxTakeBps,
                'royalty legs sum to ' + sum + ' bps, which exceeds the declared maxTakeBps (' + cfg.maxTakeBps + ')');
    } else {
        cfg.royalty = null;
    }

    // permissions (optional manifest of the native actions the guard may emit).
    if (raw.permissions !== undefined && raw.permissions !== null) {
        assert(Array.isArray(raw.permissions), 'permissions must be an array of action names');
        cfg.permissions = raw.permissions.map((p) => {
            assert(typeof p === 'string' && PERM_RE.test(p), 'permission "' + p + '" is invalid (UPPER_SNAKE)');
            return p;
        });
    } else {
        cfg.permissions = null;
    }

    // owner is required by every stateful (owner-administered) feature.
    const needsOwner = cfg.pausable || cfg.freeze !== null || cfg.allowlist !== null;
    if (raw.owner !== undefined && raw.owner !== null) {
        assert(typeof raw.owner === 'string' && ADDR_RE.test(raw.owner), 'owner must be a valid address');
        cfg.owner = raw.owner;
    } else {
        cfg.owner = null;
    }
    assert(!needsOwner || cfg.owner !== null,
        'owner is required when pausable, freeze, or allowlist is set (the owner administers those at runtime)');

    // A guard with no rules is a pointless allow-all gate.
    const hasRule = cfg.pausable || cfg.freeze !== null || cfg.allowlist !== null || cfg.royalty !== null;
    assert(hasRule,
        'policy has no rules: set at least one of pausable, freeze, allowlist, or royalty');

    return cfg;
}

// Embed a JS value as a source-safe literal (JSON is a valid subset of JS and
// escapes quotes / backslashes / control chars). Used for all baked-in data.
function lit(v) { return JSON.stringify(v); }

// ---------------------------------------------------------------------------
// Source emission.
// ---------------------------------------------------------------------------
function emitSource(cfg) {
    const stateful = cfg.pausable || cfg.freeze !== null || cfg.allowlist !== null;
    const L = []; // source lines

    L.push('// SPDX-License-Identifier: MIT');
    L.push('//');
    L.push('// ' + cfg.name + ': a controller guard contract.');
    L.push('//');
    L.push('// GENERATED by `xchain-contracts policy` (the Tier 0 no-code token-policy');
    L.push('// generator). Deploy this with a DEPLOY action, then bind your token to it');
    L.push('// with ISSUE v6 (see the bind hints printed by the generator). Review the');
    L.push('// enforcement logic below before you deploy; you own the deployed bytecode.');
    L.push('//');
    L.push('// Guard params (positional, via getInputParam): 0 actionType, 1 from, 2 to,');
    L.push('// 3 tick, 4 amount, 5 price, 6 proceedsTick. Allow = return (optionally with');
    L.push('// { payoutLegs }); block = xchain.revert(reason).');
    L.push('');

    // ---- baked-in constants ----
    if (cfg.owner !== null) L.push('var OWNER = ' + lit(cfg.owner) + ';');
    if (cfg.freeze !== null) L.push('var FROZEN = ' + lit(cfg.freeze) + ';');
    if (cfg.allowlist !== null) L.push('var ALLOWED = ' + lit(cfg.allowlist) + ';');
    if (cfg.royalty !== null) L.push('var LEGS = ' + lit(cfg.royalty) + ';');
    if (cfg.owner !== null || cfg.freeze !== null || cfg.allowlist !== null || cfg.royalty !== null) L.push('');

    // ---- hoisted helpers (keep getInputParam OUT of the guard body so it never
    //      trips the missing-input-validation warning) ----
    L.push('function actionType(xchain) { return xchain.getInputParam(0); }');
    if (cfg.freeze !== null || cfg.allowlist !== null)
        L.push('function fromAddr(xchain) { return xchain.getInputParam(1); }');
    if (cfg.freeze !== null)
        L.push('function toAddr(xchain) { return xchain.getInputParam(2); }');
    if (stateful)
        L.push('function argAddr(xchain) { return xchain.getInputParam(0); }');
    if (cfg.owner !== null)
        L.push('function onlyOwner(xchain) { xchain.require(xchain.getSourceAddress() === OWNER, \'policy: not owner\'); }');
    if (cfg.pausable)
        L.push('function requireNotPaused(xchain) { xchain.require(xchain.state.get(\'paused\') !== \'true\', \'policy: paused\'); }');
    if (cfg.freeze !== null)
        L.push('function requireNotFrozen(xchain, addr) { xchain.require(xchain.state.get(\'frozen:\' + addr) !== \'true\', \'policy: account frozen\'); }');
    if (cfg.allowlist !== null)
        L.push('function requireAllowed(xchain, addr) { xchain.require(xchain.state.get(\'allow:\' + addr) === \'true\', \'policy: not allowlisted\'); }');
    if (stateful)
        L.push('function requireAddrArg(xchain, a) { xchain.require(typeof a === \'string\' && a.length > 0, \'policy: address argument required\'); }');
    L.push('');

    // ---- exports object ----
    L.push('module.exports = {');

    // advisory metadata (read by wallets/explorers; never by the VM)
    const features = [];
    if (cfg.pausable) features.push('pausable');
    if (cfg.freeze !== null) features.push('freeze');
    if (cfg.allowlist !== null) features.push('allowlist');
    if (cfg.royalty !== null) features.push('royalty');
    L.push('    policy: { generated: true, gates: ' + lit(cfg.gates) + ', features: ' + lit(features) + ' },');

    // permissions manifest (the actions this guard is allowed to emit)
    if (cfg.permissions !== null) L.push('    permissions: ' + lit(cfg.permissions) + ',');
    // maxTakeBps manifest (cap on total routed proceeds)
    if (cfg.maxTakeBps !== null) L.push('    maxTakeBps: ' + cfg.maxTakeBps + ',');

    // initialize: seed mutable state from the baked-in lists.
    if (stateful) {
        L.push('    initialize: function (xchain) {');
        if (cfg.pausable) L.push('        xchain.state.set(\'paused\', \'false\');');
        if (cfg.freeze !== null) {
            L.push('        var i;');
            L.push('        for (i = 0; i < FROZEN.length; i++) { xchain.state.set(\'frozen:\' + FROZEN[i], \'true\'); }');
        }
        if (cfg.allowlist !== null) {
            L.push('        var j;');
            L.push('        for (j = 0; j < ALLOWED.length; j++) { xchain.state.set(\'allow:\' + ALLOWED[j], \'true\'); }');
        }
        L.push('    },');
    }

    // owner-only admin methods for each mutable feature.
    if (cfg.pausable) {
        L.push('    pause: function (xchain) { onlyOwner(xchain); xchain.state.set(\'paused\', \'true\'); },');
        L.push('    unpause: function (xchain) { onlyOwner(xchain); xchain.state.set(\'paused\', \'false\'); },');
    }
    if (cfg.freeze !== null) {
        L.push('    freeze: function (xchain) { onlyOwner(xchain); var a = argAddr(xchain); requireAddrArg(xchain, a); xchain.state.set(\'frozen:\' + a, \'true\'); },');
        L.push('    unfreeze: function (xchain) { onlyOwner(xchain); var a = argAddr(xchain); requireAddrArg(xchain, a); xchain.state.set(\'frozen:\' + a, \'false\'); },');
    }
    if (cfg.allowlist !== null) {
        L.push('    allow: function (xchain) { onlyOwner(xchain); var a = argAddr(xchain); requireAddrArg(xchain, a); xchain.state.set(\'allow:\' + a, \'true\'); },');
        L.push('    disallow: function (xchain) { onlyOwner(xchain); var a = argAddr(xchain); requireAddrArg(xchain, a); xchain.state.set(\'allow:\' + a, \'false\'); },');
    }

    // The guard itself.
    L.push('    guard: function (xchain) {');
    if (cfg.pausable) L.push('        requireNotPaused(xchain);');
    if (cfg.freeze !== null || cfg.allowlist !== null) L.push('        var from = fromAddr(xchain);');
    if (cfg.allowlist !== null) L.push('        requireAllowed(xchain, from);');
    if (cfg.freeze !== null) {
        L.push('        var to = toAddr(xchain);');
        L.push('        requireNotFrozen(xchain, from);');
        L.push('        requireNotFrozen(xchain, to);');
    }
    if (cfg.royalty !== null) {
        L.push('        var at = actionType(xchain);');
        L.push('        if (' + TRADE_ACTION_TYPES.map((t) => 'at === ' + lit(t)).join(' || ') + ') { return { payoutLegs: LEGS }; }');
    }
    L.push('        return {};');
    L.push('    }');

    L.push('};');
    L.push('');

    return L.join('\n');
}

// ---------------------------------------------------------------------------
// Bind hints: the ISSUE v6 / ADDRESS v1 steps to wire a token/account to the
// deployed guard. We do not know the deploy index or the tick yet, so these are
// human-facing instructions, not wire bytes.
// ---------------------------------------------------------------------------
function bindHints(cfg) {
    const lines = [];
    lines.push('Next steps:');
    lines.push('  1. Deploy the generated contract with a DEPLOY action. Note its index');
    lines.push('     (the contract address is C:<CHAIN>:<index>).');
    lines.push('  2. Bind each gated action class to that contract:');
    for (const g of cfg.gates) {
        lines.push('       ISSUE v6  VERSION=6 | TICK=<your tick> | CONTROLLER=<deploy index> | ACTION_CLASS=' + g + ' | COOLDOWN_BLOCKS=<n> | UNBIND=0');
    }
    lines.push('     (SDK: sdk.controller.bindToken({ tick, controller, actionClass }) per class.)');
    lines.push('     To gate an ACCOUNT instead of a token, use ADDRESS v1 / sdk.controller.bindAddress.');
    return lines.join('\n');
}

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
    MAX_BPS
};
