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
    BINDABLE_CLASSES,
    ALLOWLIST_DIRECTIONS,
    MAX_BPS,
    PROTOCOL_MAX_TAKE_BPS,
    ADDR_RE,
    PERM_RE,
    NAME_RE
} = require('./constants');
const { isPlainObject, assert } = require('./validation_helpers');
const { isPayoutAddress } = require('./address_validation');
const { resolveMeta } = require('./metadata_resolution');

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

    // allowlistDirection (optional): which end of a move the allowlist is checked on.
    //
    // The default is 'from', which is what every guard generated before this key
    // existed enforces, so an unchanged config keeps producing byte-identical source.
    // It is NOT the safe default, it is the compatible one: under 'from' an
    // allowlisted holder can move the token to any address, and because the guard
    // then blocks that address as a SENDER the balance is stranded there. A
    // holder-restricted (security-token shaped) policy wants 'both'. The resolved
    // value is emitted into the header, the `policy` descriptor and features so the
    // deployer chooses knowingly instead of inheriting a silent one.
    if (raw.allowlistDirection !== undefined && raw.allowlistDirection !== null) {
        assert(cfg.allowlist !== null,
            'allowlistDirection requires an allowlist; it has nothing to direct on its own');
        assert(ALLOWLIST_DIRECTIONS.indexOf(raw.allowlistDirection) !== -1,
            'allowlistDirection must be one of: ' + ALLOWLIST_DIRECTIONS.join(', '));
        cfg.allowlistDirection = raw.allowlistDirection;
    } else {
        cfg.allowlistDirection = cfg.allowlist !== null ? 'from' : null;
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
            assert(isPayoutAddress(leg.to),
                'royalty leg "to" (' + leg.to + ') must be a real base58check or bech32 address on the chain '
                + 'this token lives on. A placeholder, a typo, or a contract address like "C:BTC:123" is '
                + 'rejected by the chain at match time as "controller (bad payout leg)", which denies EVERY '
                + 'ORDER_CREATE and SWAP_CREATE for the token - the token cannot be listed at all, and the '
                + 'failure is first visible only after deploy and bind');
            assert(Number.isInteger(leg.bps) && leg.bps > 0 && leg.bps <= MAX_BPS,
                'royalty leg bps must be an integer in [1, ' + MAX_BPS + ']');
            sum += leg.bps;
            return { to: leg.to, bps: leg.bps };
        });
        assert(sum <= MAX_BPS, 'royalty legs sum to ' + sum + ' bps, which exceeds 100% (' + MAX_BPS + ')');
        // Refuse a split the chain's protocol cap would deny at every listing create.
        assert(sum <= PROTOCOL_MAX_TAKE_BPS,
            'royalty legs sum to ' + sum + ' bps, which exceeds the protocol cap CONTROLLER_MAX_TAKE_BPS ('
            + PROTOCOL_MAX_TAKE_BPS + '); the chain would deny every ORDER_CREATE and SWAP_CREATE for this token');
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

    // meta (optional): contract identity. Resolved LAST because the generated default
    // description names the resolved gates and features, which every block above sets.
    // A caller-supplied field wins outright; only the fields they leave out are
    // generated, so a deployer can name their guard without also having to describe it.
    // Defaulting rather than requiring is the point: the no-code path must not be able
    // to emit a guard that consensus refuses at deploy.
    cfg.meta = resolveMeta(raw.meta, cfg);
    return cfg;
}

module.exports = { validateConfig };
