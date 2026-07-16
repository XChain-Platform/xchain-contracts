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
// Access control: owner / role guards.
//
// Paste the helpers you need ABOVE your `module.exports` (top-level function
// declarations are hoisted, so methods can call them) and invoke them at the
// top of a method. Convention: store the owner address in state under 'owner'
// in initialize(); store other roles under their own keys.
//
//   module.exports = {
//     initialize: function (xchain) {
//       xchain.state.set('owner', xchain.getInputParam(0));
//     },
//     withdraw: function (xchain) {
//       onlyOwner(xchain);
//       // ... owner-only logic ...
//     }
//   };

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
