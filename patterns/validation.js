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

// Throw unless parseInt(v) is an integer within [min, max] inclusive.
function requireIntInRange(xchain, v, min, max, name) {
    var n = parseInt(v);
    xchain.require(n >= min && n <= max,
        name + ' must be an integer in [' + min + ', ' + max + ']');
}
