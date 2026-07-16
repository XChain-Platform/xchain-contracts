/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

// SPDX-License-Identifier: MIT
//
// Input validation: the shapes every public method should check up front.
// Pairs with the linter's `missing-input-validation` warning: validate inputs
// before you use them. All amounts are string bignumbers (use xchain.math, never
// native number arithmetic).
//
//   initialize: function (xchain) {
//     var owner    = xchain.getInputParam(0);
//     var amount   = xchain.getInputParam(1);
//     var deadline = xchain.getInputParam(2);
//     requireAddress(xchain, owner, 'owner');
//     requirePositive(xchain, amount, 'amount');
//     requireIntInRange(xchain, deadline, 1, 1000000, 'deadlineBlocks');
//   }

// Throw unless `v` is a non-empty string (addresses, ticks, ids).
function requireAddress(xchain, v, name) {
    xchain.require(typeof v === 'string' && v.length > 0, name + ' is required');
}

// Throw unless `amount` is a positive bignumber (string amount).
function requirePositive(xchain, amount, name) {
    xchain.require(amount && xchain.math.gt(amount, '0'), name + ' must be positive');
}

// Throw unless `v` is exactly one of `allowed` (an array of strings).
function requireEnum(xchain, v, allowed, name) {
    var ok = false;
    for (var i = 0; i < allowed.length; i++) {
        if (v === allowed[i]) { ok = true; break; }
    }
    xchain.require(ok, name + ' must be one of: ' + allowed.join(', '));
}

// Throw unless `v` is a canonical base-10 integer string within [min, max]
// inclusive. Validate the SHAPE of `v`, not parseInt(v): a radix-less parseInt
// silently accepts non-integers a range check then blesses ('5.99' -> 5,
// '500abc' -> 500, '0x100' -> 256, ' 5' -> 5), so a template that stored the raw
// param would carry a value the check never truly approved. Scan for an exact
// integer shape (optional leading '-', then one-or-more digits, nothing else)
// with plain character comparisons; a regex literal would be rejected by the VM's
// determinism validator (RegExp is not allowed in contract source).
function requireIntInRange(xchain, v, min, max, name) {
    var msg = name + ' must be an integer in [' + min + ', ' + max + ']';
    var s = (typeof v === 'string') ? v : '';
    var i = (s.charAt(0) === '-') ? 1 : 0;
    var ok = s.length > i; // at least one digit after an optional sign
    for (; i < s.length; i++) {
        var ch = s.charAt(i);
        if (ch < '0' || ch > '9') { ok = false; break; }
    }
    xchain.require(ok, msg);
    var n = parseInt(s, 10);
    xchain.require(n >= min && n <= max, msg);
}
