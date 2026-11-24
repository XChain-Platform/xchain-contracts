// SPDX-License-Identifier: MIT
//
// Access control: owner / role guards.
//
// Paste the helpers you need ABOVE your `module.exports` (top-level function
// declarations are hoisted, so methods can call them) and invoke them at the
// top of a method. Convention: store the owner address in state under 'owner'
// in initialize(); store other roles under their own keys.
//
//   module.exports = {
//     initialize: function (xchain) {
//       requireUninitialized(xchain, 'owner');
//       xchain.state.set('owner', xchain.getInputParam(0));
//     },
//     withdraw: function (xchain) {
//       onlyOwner(xchain);
//       // ... owner-only logic ...
//     }
//   };

// Throw if initialize() already ran. Call it FIRST in initialize(): EXECUTE dispatches
// any exported method, initialize included, so without it anyone can replay
// initialize naming themselves owner and then pass onlyOwner. `key` must be a
// state key initialize() always sets and no method ever deletes (e.g. 'owner');
// a key that can be unset leaves the guard open.
function requireUninitialized(xchain, key) {
    xchain.require(xchain.state.get(key) === null, 'already initialized');
}

// Throw unless the caller is the contract owner (state key 'owner').
function onlyOwner(xchain) {
    xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'),
        'caller is not the owner');
}

// Non-throwing form, for branching.
function isOwner(xchain) {
    return xchain.getSourceAddress() === xchain.state.get('owner');
}

// Throw unless the caller matches the address stored under `roleKey`
// (e.g. 'arbiter', 'beneficiary', 'grantor'). Set the role in initialize().
function onlyRole(xchain, roleKey) {
    xchain.require(xchain.getSourceAddress() === xchain.state.get(roleKey),
        'caller is not authorized (' + roleKey + ')');
}
