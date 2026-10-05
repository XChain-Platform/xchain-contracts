// SPDX-License-Identifier: MIT

'use strict';

const { allowlistDirectionNotes, royaltyScopeNotes } = require('./source-emission');

function accountBindNotes(cfg) {
    const notes = [
        'An ACCOUNT may bind this guard instead (ADDRESS v1 / sdk.controller.bindAddress),',
        'but the chain runs an account guard for `transfer` ONLY: both sides of a direct',
        'SEND, and from the CONTROLLER_CUSTODY_GUARD flag day that account\'s contract-',
        'custody deposits and withdrawals. DEX and dispenser deliveries are never gated',
        'on an account.'
    ];
    const tokenOnly = cfg.gates.filter(g => g !== 'transfer' && g !== 'all');
    if (tokenOnly.length > 0)
        notes.push('An account bind will NOT enforce ' + tokenOnly.join(', ') + '; bind those to a token via ISSUE v6.');
    if (cfg.gates.indexOf('all') !== -1)
        notes.push('An `all` binding on an account fires for transfer only.');
    if (cfg.royalty !== null)
        notes.push('An account bind never yields a royalty split; the split needs the token trade class.');
    if (cfg.gates.indexOf('transfer') === -1 && cfg.gates.indexOf('all') === -1)
        notes.push('This policy gates no transfer, so an account bind of it enforces nothing.');
    return notes;
}

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
    for (const n of accountBindNotes(cfg)) lines.push('     ' + n);
    if (cfg.allowlist !== null) {
        lines.push('');
        lines.push('  Allowlist direction: ' + cfg.allowlistDirection + '.');
        for (const n of allowlistDirectionNotes(cfg.allowlistDirection)) lines.push('    ' + n);
    }
    if (cfg.royalty !== null) {
        lines.push('');
        for (const n of royaltyScopeNotes()) lines.push('    ' + n);
    }
    return lines.join('\n');
}

module.exports = { bindHints };
