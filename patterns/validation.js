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
//     requirePlainDecimal(xchain, amount, 'amount');
//     requireIntInRange(xchain, deadline, 1, 1000000, 'deadlineBlocks');
//   }

// Throw unless `v` is a non-empty string (addresses, ticks, ids).
function requireAddress(xchain, v, name) {
    xchain.require(typeof v === 'string' && v.length > 0, name + ' is required');
}

// Throw unless `amount` is a positive bignumber (string amount).
//
// INSUFFICIENT ON ITS OWN for any value that later reaches a fixed-notation
// string helper such as `floorToDecimals` (amm/crowdsale/treasury/stableVault/
// priceBet all carry one). This is a magnitude test, not a notation test:
// xchain.math parses every spelling mathjs accepts, so '1.5e-8', '0x10',
// '1_000', '+1', '.5' and 'Infinity' are all "positive" here. That costs nothing
// while the value only ever flows through xchain.math (the VM formats every math
// result in fixed notation, xchain-vm/src/math.js toFixed), but a value that is
// raw caller text and reaches string surgery must ALSO pass requirePlainDecimal
// below, or the surgery silently corrupts it. Pair the two checks at the door.
function requirePositive(xchain, amount, name) {
    xchain.require(amount && xchain.math.gt(amount, '0'), name + ' must be positive');
}

// Throw unless `value` is a plain fixed-notation decimal: digits, with at most
// one decimal point that has digits on both sides. The notation gate that
// `requirePositive` above is not.
//
// Use it on every numeric term that arrives as raw untrusted TEXT (constructor
// params, method params) and is later handed to a fixed-notation string helper
// such as `floorToDecimals`. Those helpers presuppose fixed notation, and fed a
// spelling mathjs accepts but they do not understand they do not merely no-op,
// they CORRUPT:
//   '1.5e-8'       -> the fraction reads as '5e-8', 4 chars, so an 8-decimal
//                     grid check sees an already-on-grid value and the off-grid
//                     amount is written and emitted raw.
//   '1.23456789e2' -> returns '1.23456789' for a value of 123.456789, so a
//                     payout is silently 1% of what it should be. No revert.
// Either way the books and the wire disagree and the loss is permanent.
//
// This is a NOTATION check, not a grid check, and it does not replace the floor:
// '0.000000015' is legitimately spelled and still off an 8-decimal grid. A tick's
// decimals are often unreadable at the door anyway (a contract that holds none of
// the tick yet has no ledger entry for it), which is exactly why the two checks
// live in different places. Notation is checked here; the grid is checked at the
// consumer.
//
// No RegExp: the VM's determinism validator rejects RegExp literals in contract
// source, so this is a character walk (the same constraint that shaped
// requireIntInRange below). The loop is gas-metered per iteration, so an
// oversized param exhausts the caller's own gas rather than costing anyone else.
function requirePlainDecimal(xchain, value, label) {
    var s = String(value);
    xchain.require(s.length > 0, label + ' must be a plain decimal string');
    var dot = -1;
    for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        if (c === '.') {
            xchain.require(dot < 0, label + ' must carry at most one decimal point');
            xchain.require(i > 0 && i < s.length - 1,
                label + ' needs digits on both sides of its decimal point');
            dot = i;
        } else {
            xchain.require(c >= '0' && c <= '9',
                label + ' must be a plain decimal: digits and one optional decimal point, ' +
                'no exponent / sign / radix prefix (got "' + s + '")');
        }
    }
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
