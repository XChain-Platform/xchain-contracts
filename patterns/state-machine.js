// SPDX-License-Identifier: MIT
//
// State machine: a single 'status' enum with guarded transitions.
//
// Initialize 'status' in initialize(); guard each method with requireStatus and
// advance with setStatus. Makes a contract's lifecycle explicit and blocks
// out-of-order calls (e.g. claiming before funding). Commit the status change
// BEFORE emitting tokens so a terminal state can't be re-entered (emissions
// apply atomically after the method returns).
//
//   module.exports = {
//     initialize: function (xchain) { xchain.state.set('status', 'INIT'); /* ... */ },
//     fund:    function (xchain) { requireStatus(xchain, 'INIT');   /* ... */ setStatus(xchain, 'FUNDED');   },
//     release: function (xchain) { requireStatus(xchain, 'FUNDED'); /* ... */ setStatus(xchain, 'RELEASED'); }
//   };

// Throw unless the current 'status' equals `expected`.
function requireStatus(xchain, expected) {
    var current = xchain.state.get('status');
    xchain.require(current === expected,
        'invalid state: expected ' + expected + ', got ' + current);
}

// Throw unless the current 'status' is one of `allowed` (an array of strings).
function requireStatusIn(xchain, allowed) {
    var current = xchain.state.get('status');
    var ok = false;
    for (var i = 0; i < allowed.length; i++) {
        if (current === allowed[i]) { ok = true; break; }
    }
    xchain.require(ok, 'invalid state: ' + current + ' not in [' + allowed.join(', ') + ']');
}

// Advance the lifecycle status. Commit this BEFORE emitting (see file header).
function setStatus(xchain, next) {
    xchain.state.set('status', next);
}
