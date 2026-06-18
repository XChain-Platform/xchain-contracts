// SPDX-License-Identifier: MIT
//
// Safe custody: read your OWN balance; never trust a caller-supplied amount.
//
// XChain has no msg.value: tokens reach a contract via a separate DEPOSIT to its
// address (C:<CHAIN>:<index>). Always size a transfer from what the contract
// actually holds, and COMMIT state before emitting. Emissions are deferred and
// applied atomically AFTER your method returns (see the developer guide,
// "Snapshot Semantics"), so a contract can never observe its own emission
// mid-execution.
//
//   module.exports = {
//     payout: function (xchain) {
//       var tick   = xchain.state.get('tick');
//       var amount = heldBalance(xchain, tick);          // size from real holdings
//       xchain.require(xchain.math.gt(amount, '0'), 'nothing to pay out');
//       xchain.state.set('status', 'PAID');              // commit state FIRST
//       xchain.emit.send({ destination: xchain.state.get('payee'), tick: tick, quantity: amount });
//     }
//   };

// The contract's own balance of `tick`, defaulting to '0' for an untracked tick.
function heldBalance(xchain, tick) {
    return xchain.getBalance(xchain.getContractAddress(), tick) || '0';
}

// Throw unless the contract holds at least `amount` of `tick`.
function requireHeld(xchain, tick, amount) {
    xchain.require(xchain.math.gte(heldBalance(xchain, tick), amount),
        'insufficient contract balance of ' + tick);
}

// The amount newly DEPOSITed this batch: current held minus a previously-recorded
// reserve. Pattern for "act on exactly what the caller just sent" (see the AMM's
// swap, which derives amountIn from balance minus reserve).
function depositedSince(xchain, tick, reserve) {
    return xchain.math.subtract(heldBalance(xchain, tick), reserve || '0');
}
