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
// Pausable: an owner-controlled circuit breaker.
//
// Store a 'paused' flag in state ('true' / 'false'). Guard sensitive methods
// with whenNotPaused(xchain). Add owner-only pause()/unpause() methods that call
// setPaused; gate those with onlyOwner (see access-control.js).
//
//   module.exports = {
//     pause:   function (xchain) { onlyOwner(xchain); setPaused(xchain, true); },
//     unpause: function (xchain) { onlyOwner(xchain); setPaused(xchain, false); },
//     buy:     function (xchain) { whenNotPaused(xchain); /* ... */ }
//   };

// Throw if the contract is paused (state key 'paused' === 'true').
function whenNotPaused(xchain) {
    xchain.require(xchain.state.get('paused') !== 'true', 'contract is paused');
}

// True if currently paused.
function isPaused(xchain) {
    return xchain.state.get('paused') === 'true';
}

// Set the paused flag. Gate the calling method with onlyOwner.
function setPaused(xchain, paused) {
    xchain.state.set('paused', paused ? 'true' : 'false');
}
