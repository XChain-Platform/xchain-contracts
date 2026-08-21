// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// policy-matrix.js: the shared policy-gen config matrix.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Two suites exercise the SAME representative configs from opposite sides:
// lib/policy-gen.test.js (acorn lint + mock-xchain behaviour, runs on any Node)
// and lib/policy-gen.e2e.test.js (the real V8 compile / isolated-vm deploy gate,
// Node 22 only). Held here so a config added for one is covered by both; a copy
// in each file would let the real-VM half silently fall behind.
//
// Not a *.test.js file, so test/gate-wiring.test.js does not require it to be
// listed in scripts.test.

'use strict';

const OWNER = '1OwnerAddress';
const NOTOWNER = '1SomebodyElse';

// A representative matrix: every feature alone, plus the whole stack together.
const MATRIX = {
    full: { name: 'Full', owner: OWNER, gates: ['transfer', 'trade'], pausable: true, freeze: ['1Frozen'], allowlist: ['1Good'], royalty: [{ to: '1Creator', bps: 250 }, { to: '1Market', bps: 100 }], maxTakeBps: 1000, permissions: ['SEND'] },
    pauseOnly: { name: 'PauseOnly', owner: OWNER, gates: ['transfer'], pausable: true },
    freezeOnly: { name: 'FreezeOnly', owner: OWNER, gates: ['transfer', 'trade'], freeze: ['1Frozen'] },
    allowOnly: { name: 'AllowOnly', owner: OWNER, gates: ['all'], allowlist: ['1Good', '1AlsoGood'] },
    royaltyOnly: { name: 'RoyaltyOnly', gates: ['trade'], royalty: [{ to: '1Creator', bps: 500 }] }
};

module.exports = { OWNER, NOTOWNER, MATRIX };
