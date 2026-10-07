// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND. See the MIT License for the full text.

'use strict';

const { TRADE_ACTION_TYPES } = require('./constants');

// Embed a JS value as a source-safe literal (JSON is a valid subset of JS and
// escapes quotes / backslashes / control chars). Used for all baked-in data.
function lit(v) { return JSON.stringify(v); }

// The generated header's allowlist paragraph, as comment lines (no leading '//').
// States which end is enforced and what that costs, so a reader of the generated
// policy can tell a sender-only allowlist from a two-sided one.
function allowlistDirectionNotes(dir) {
    const notes = [];
    if (dir === 'both') {
        notes.push('Allowlist enforcement: SENDER and RECIPIENT (allowlistDirection "both").');
    } else if (dir === 'to') {
        notes.push('Allowlist enforcement: RECIPIENT only (allowlistDirection "to"). Any');
        notes.push('address may SEND the token; only allowlisted addresses may receive it.');
    } else {
        notes.push('Allowlist enforcement: SENDER only (allowlistDirection "from", the');
        notes.push('default, and the only behaviour guards generated before this key had).');
        notes.push('An allowlisted holder can move the token to ANY address, and the guard');
        notes.push('then blocks that address as a SENDER, so the balance is stranded there.');
        notes.push('Set allowlistDirection to "both" for a holder-restricted policy.');
    }
    notes.push('No setting is a COMPLETE holder restriction. Actions that carry no');
    notes.push('recipient (burns, and the escrow-creating order/swap/dispenser/airdrop/');
    notes.push('dividend actions) pass an empty `to` and are exempt, and matched trade');
    notes.push('settlement invokes no guard at all, so a matched buyer can still end up');
    notes.push('holding the token.');
    notes.push('From the CONTROLLER_CUSTODY_GUARD flag day, a contract\'s custody address C:<CHAIN>:<index> is the recipient of a DEPOSIT and the sender of a WITHDRAW; allowlist it for the token to enter or leave that contract.');
    return notes;
}

// The generated header's royalty paragraph, as comment lines (no leading '//').
// States which trade-class actions the split reaches and which it does not, so a
// deployer learns before binding that a dispenser sells the token royalty-free.
// Derived from the indexer: ORDER_CREATE and SWAP_CREATE persist the legs at
// create and apply them at match time; DISPENSER_CREATE routes to the same trade
// class but its handler consumes only a revert and discards payoutLegs, a refill
// does the same as DISPENSER_REFILL from that flag day, and the per-buy dispense
// path runs no guard at all (xchain-indexer/src/actions/dispenser/
// controller_guard.js, dispense/). The cross-chain paragraph mirrors crossChainRoyaltyError
// in the indexer's order and swap controller_guard.js.
function royaltyScopeNotes() {
    return [
        'Royalty scope: the proceeds split is returned for ORDER_CREATE and',
        'SWAP_CREATE only. The indexer records the legs when the order or swap is',
        'listed and applies them when it matches. DISPENSER_CREATE is in the same',
        'trade class, so this guard runs when a holder opens a dispenser, but the',
        'dispenser path honours only a revert: the legs it returns are discarded',
        'and dispenser sales pay NO split. A holder can sell this token through a',
        'dispenser royalty-free. From the DISPENSER_REFILL flag day this guard',
        'also runs, veto-only in the same way, on every refill that adds escrow,',
        'so it can deny a refill of a dispenser opened before the bind. Below that',
        'flag day a dispenser opened before the bind runs this guard at no point.',
        '',
        'Leg addresses: every leg "to" must be a real address on the chain this',
        'token lives on. The indexer re-validates each returned leg and fails',
        'CLOSED on the whole action, so a placeholder, a typo, a wrong-network',
        'address or a contract address ("C:BTC:123") denies every ORDER_CREATE',
        'and SWAP_CREATE for the token with "controller (bad payout leg)". The',
        'generator checks the checksum, but it cannot check the network: confirm',
        'each address belongs to this chain before you bind.',
        '',
        'Cross-chain listings: an ORDER_CREATE or SWAP_CREATE whose proceeds',
        'settle on another chain (GET_COIN is not this chain) is DENIED while the',
        'network\'s CROSS_CHAIN_ROYALTY protocol change is inactive, so until then',
        'this token sells only for proceeds on its own chain. Once the flag is',
        'active, every leg "to" must also be payable on the proceeds chain',
        '(re-encodable to that chain\'s address format), or the listing is denied:',
        'a bech32 leg, for example, cannot be paid on a chain with no bech32',
        'prefix. The generator cannot check this, because the proceeds chain is',
        'chosen per listing.'
    ];
}

// ---------------------------------------------------------------------------
// Source emission.
// ---------------------------------------------------------------------------
function emitSource(cfg) {
    const stateful = cfg.pausable || cfg.freeze !== null || cfg.allowlist !== null;
    // Resolved allowlist ends. Null when there is no allowlist, so every `allowFrom`
    // / `allowTo` test below is false and a non-allowlist config emits exactly what
    // it emitted before this knob existed.
    const allowFrom = cfg.allowlistDirection === 'from' || cfg.allowlistDirection === 'both';
    const allowTo   = cfg.allowlistDirection === 'to'   || cfg.allowlistDirection === 'both';
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
    if (cfg.allowlist !== null) {
        L.push('//');
        for (const n of allowlistDirectionNotes(cfg.allowlistDirection)) L.push('// ' + n);
    }
    if (cfg.royalty !== null) {
        L.push('//');
        for (const n of royaltyScopeNotes()) L.push('// ' + n);
    }
    L.push('');

    // ---- baked-in constants (each only where something reads it) ----
    const adminAddr = cfg.freeze !== null || cfg.allowlist !== null;
    if (stateful) L.push('var OWNER = ' + lit(cfg.owner) + ';');
    if (cfg.freeze !== null) L.push('var FROZEN = ' + lit(cfg.freeze) + ';');
    if (cfg.allowlist !== null) L.push('var ALLOWED = ' + lit(cfg.allowlist) + ';');
    if (cfg.royalty !== null) L.push('var LEGS = ' + lit(cfg.royalty) + ';');
    if (stateful || cfg.royalty !== null) L.push('');

    // ---- hoisted helpers (keep getInputParam OUT of the guard body so it never
    //      trips the missing-input-validation warning) ----
    if (cfg.royalty !== null)
        L.push('function actionType(xchain) { return xchain.getInputParam(0); }');
    if (cfg.freeze !== null || allowFrom)
        L.push('function fromAddr(xchain) { return xchain.getInputParam(1); }');
    if (cfg.freeze !== null || allowTo)
        L.push('function toAddr(xchain) { return xchain.getInputParam(2); }');
    if (adminAddr)
        L.push('function argAddr(xchain) { return xchain.getInputParam(0); }');
    if (stateful)
        L.push('function onlyOwner(xchain) { xchain.require(xchain.getSourceAddress() === OWNER, \'policy: not owner\'); }');
    if (cfg.pausable)
        L.push('function requireNotPaused(xchain) { xchain.require(xchain.state.get(\'paused\') !== \'true\', \'policy: paused\'); }');
    if (cfg.freeze !== null)
        L.push('function requireNotFrozen(xchain, addr) { xchain.require(xchain.state.get(\'frozen:\' + addr) !== \'true\', \'policy: account frozen\'); }');
    if (cfg.allowlist !== null)
        L.push('function requireAllowed(xchain, addr) { xchain.require(xchain.state.get(\'allow:\' + addr) === \'true\', \'policy: not allowlisted\'); }');
    if (adminAddr)
        L.push('function requireAddrArg(xchain, a) { xchain.require(typeof a === \'string\' && a.length > 0, \'policy: address argument required\'); }');
    L.push('');

    // ---- exports object ----
    L.push('module.exports = {');
    // Contract identity, FIRST key: unlike the `policy` descriptor below it is not
    // advisory. The indexer reads it off the deployed export and rejects a DEPLOY that
    // carries no name and description, so a guard emitted without this block cannot be
    // deployed at all.
    L.push('    // Contract identity. Required at deploy; bump version when you edit this file.');
    L.push('    meta: {');
    L.push('        name: ' + lit(cfg.meta.name) + ',');
    L.push('        description: ' + lit(cfg.meta.description) + ',');
    L.push('        version: ' + lit(cfg.meta.version));
    L.push('    },');

    // advisory metadata (read by wallets/explorers; never by the VM)
    const features = [];
    if (cfg.pausable) features.push('pausable');
    if (cfg.freeze !== null) features.push('freeze');
    if (cfg.allowlist !== null) features.push('allowlist');
    if (cfg.royalty !== null) features.push('royalty');
    L.push('    policy: { generated: true, gates: ' + lit(cfg.gates) + ', features: ' + lit(features) +
           (cfg.allowlistDirection !== null ? ', allowlistDirection: ' + lit(cfg.allowlistDirection) : '') + ' },');

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
    if (cfg.freeze !== null || allowFrom) L.push('        var from = fromAddr(xchain);');
    // `var to` is declared exactly once: here when only the allowlist needs it, or in
    // the freeze block below, which needs it anyway and keeps its historical position.
    if (allowTo && cfg.freeze === null) L.push('        var to = toAddr(xchain);');
    if (allowFrom) L.push('        requireAllowed(xchain, from);');
    if (cfg.freeze !== null) {
        L.push('        var to = toAddr(xchain);');
        L.push('        requireNotFrozen(xchain, from);');
        L.push('        requireNotFrozen(xchain, to);');
    }
    // Exempt the recipient when the indexer passes an empty `to` for DESTROY, STAKE,
    // ORDER_CREATE, SWAP_CREATE, DISPENSER_CREATE, DISPENSER_REFILL, AIRDROP, or
    // DIVIDEND, because an unconditional check would deny burns and escrow creation.

    // Apply recipient checks to DEPOSIT and WITHDRAW from the
    // CONTROLLER_CUSTODY_GUARD flag day because both supply a non-empty recipient
    // on their contract custody route.
    if (allowTo) L.push('        if (to !== \'\') { requireAllowed(xchain, to); }');
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

module.exports = { emitSource, allowlistDirectionNotes, royaltyScopeNotes };
