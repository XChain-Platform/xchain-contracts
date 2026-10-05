// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND. See the MIT License for the full text.

'use strict';

// The native action classes a token/account may gate. Two lists with two
// different seam partners in xchain-indexer/src/config.js:
//   ACTION_CLASSES   is the ROUTABLE set (an incoming action maps to exactly one
//                    of these) and must match CONTROLLER_ACTION_CLASSES.
//   BINDABLE_CLASSES is what a bind may target: the routable set plus the 'all'
//                    catch-all, and must match CONTROLLER_BINDABLE_CLASSES. The
//                    SDK's controller.js ACTION_CLASSES is this BINDABLE set,
//                    despite its name.
// Do not append 'all' to ACTION_CLASSES to match the SDK list: BINDABLE_CLASSES
// derives from it and would then carry 'all' twice. 'ownership' is a live,
// routable, chain-bindable class (SWEEP deed-over gating, per
// controller-bound-tokens.md); the generated guard body needs no change since it
// returns {} for unrecognised action types. 'all' gates every routable class,
// present and future. policy-gen.test.js pins BINDABLE_CLASSES to the canonical set.
const ACTION_CLASSES = ['transfer', 'trade', 'burn', 'mint', 'stake', 'ownership'];
const BINDABLE_CLASSES = ACTION_CLASSES.concat(['all']);
// The action types (getInputParam(0) inside a guard) that represent a trade,
// i.e. the ones a royalty/fee split may be returned for.
const TRADE_ACTION_TYPES = ['ORDER_CREATE', 'SWAP_CREATE'];
// Which end(s) of a move an `allowlist` is enforced on. See validateConfig's
// allowlistDirection block for why the default is 'from' and not 'both'.
const ALLOWLIST_DIRECTIONS = ['from', 'to', 'both'];
// Bound every bps value by 100% (10000). This is the conservation bound and the
// range a manifest maxTakeBps must fall in, mirroring xchain-indexer's
// src/actions/deploy/manifest.js; the platform root's controller parity gate pins the two.
const MAX_BPS = 10000; // 100.00% in basis points
// Cap the total royalty a sale guard may route at the chain's protocol ceiling. It MUST
// equal CONTROLLER_MAX_TAKE_BPS in xchain-indexer/src/config.js: over it, the chain denies
// every ORDER_CREATE and SWAP_CREATE for the token. The same parity gate pins the two.
const PROTOCOL_MAX_TAKE_BPS = 10000;

// Conservative charset gate for anything embedded into the generated source as a
// string literal. We ALSO embed via JSON.stringify (which escapes correctly), so
// this is a defence-in-depth reject of obviously bogus / injection-shaped input
// with a clear error rather than a broken contract.
const ADDR_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const PERM_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,60}$/;
// Contract identity (`meta`) is consensus-required at deploy: the indexer rejects a
// DEPLOY whose contract exports no meta.name / meta.description, and its grammar
// bans control, zero-width and bidi code points and untrimmed edges. This gate is
// deliberately NARROWER than that grammar (printable ASCII, no leading or trailing
// space) rather than a second copy of it: printable ASCII is a strict subset of what
// consensus accepts, so anything this generator emits is deployable, and the one
// authority on the grammar stays in the indexer. Byte caps match the consensus caps,
// and ASCII makes byte length and string length the same number.
const META_TEXT_RE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const META_NAME_MAX = 64;
const META_DESCRIPTION_MAX = 512;
const META_VERSION_MAX = 32;

module.exports = {
    ACTION_CLASSES,
    BINDABLE_CLASSES,
    TRADE_ACTION_TYPES,
    ALLOWLIST_DIRECTIONS,
    MAX_BPS,
    PROTOCOL_MAX_TAKE_BPS,
    ADDR_RE,
    PERM_RE,
    NAME_RE,
    META_TEXT_RE,
    META_NAME_MAX,
    META_DESCRIPTION_MAX,
    META_VERSION_MAX
};
