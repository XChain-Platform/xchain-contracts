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
//       xchain.require(!isAtLeastExact(xchain, '0', amount), 'nothing to pay out');
//       xchain.state.set('status', 'PAID');              // commit state FIRST
//       xchain.emit.send({ destination: xchain.state.get('payee'), tick: tick, quantity: amount });
//     }
//   };

// The contract's own balance of `tick`, defaulting to '0' for an untracked tick.
function heldBalance(xchain, tick) {
    return xchain.getBalance(xchain.getContractAddress(), tick) || '0';
}

// Throw unless the contract holds at least `amount` of `tick`, compared exactly.
// Paste isAtLeastExact from validation.js alongside (xchain.math.gte is tolerant).
function requireHeld(xchain, tick, amount) {
    xchain.require(isAtLeastExact(xchain, heldBalance(xchain, tick), amount),
        'insufficient contract balance of ' + tick);
}

// The amount newly DEPOSITed this batch: current held minus a previously-recorded
// reserve. Pattern for "act on exactly what the caller just sent" (see the AMM's
// swap, which derives amountIn from balance minus reserve).
function depositedSince(xchain, tick, reserve) {
    return xchain.math.subtract(heldBalance(xchain, tick), reserve || '0');
}

// Quantise a fixed-notation quantity DOWN onto a tick's decimal grid before you emit
// it. The indexer rounds an off-grid emission HALF-UP, which can pay out more than
// the contract holds or has booked. Exact string surgery, not mathjs floor/mod
// (those round to significant digits, not the grid). It PRESUPPOSES fixed notation:
// gate raw caller text with requirePlainDecimal (validation.js) first.
function floorToDecimals(value, decimals) {
    var s = String(value);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.substring(1);
    var dot = s.indexOf('.');
    if (dot < 0) return value;                          // already an integer
    var frac = s.substring(dot + 1);
    if (frac.length <= decimals) return value;          // already on the grid
    var kept = decimals > 0 ? '.' + frac.substring(0, decimals) : '';
    var out = s.substring(0, dot) + kept;
    return neg ? '-' + out : out;
}

// Decimals of `tick` from the ledger snapshot, reverting when the snapshot carries no
// token info (it covers only ticks the caller or this contract holds).
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}
