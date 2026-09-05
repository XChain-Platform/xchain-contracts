// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// cardDispenser.js: random card-pack dispenser backed by the contract's OWN
//                   token inventory (NO mint)
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// A buyer pays a fixed `price` of `payTick` and receives ONE unit of a randomly
// chosen card tick. The candidate cards are declared at deploy time; the prize
// pool is whatever the operator has DEPOSITed into the contract's own address
// for each card. A card is drawn with probability proportional to how many
// copies the contract holds, so RARITY IS SET BY STOCK (stock 1000 commons and
// 10 legendaries and a legendary is 100x rarer). A sold-out card (0 copies) is
// simply never drawn.
//
// CUSTODY MODEL (read this before forking)
//
// There is no msg.value on XChain. Funds enter a contract via a separate DEPOSIT
// action to the contract's own address; logic runs via EXECUTE. To pay and draw
// in ONE transaction, the buyer submits BOTH with BATCH:
//
//     BATCH( DEPOSIT(this_contract, payTick, price), EXECUTE(this_contract, "draw") )
//
// Batched sub-actions apply in order with the deposit persisted before EXECUTE
// runs, so draw() sees the payment via getBalance(). They still settle
// independently: a BATCH is NOT atomic, so a draw() that reverts ('underpaid')
// does not undo the DEPOSIT ahead of it. That is exactly why sold-out REFUNDS
// rather than reverting (see "Sold-out payment stranding"). The contract never
// trusts a caller-supplied amount; it reads its own balance delta.
//
// The contract canNOT enumerate its own holdings (the VM only exposes
// getBalance(address, tick)), so the candidate card ticks are FIXED at deploy.
//
// RANDOMNESS — IMPORTANT
//
// The VM is deterministic: there is no Math.random / Date. Entropy comes from
// xchain.getBlockHash(), which the indexer derives as sha256(blockHeight:blockTime).
// Its OUTPUT is uniform (good distribution; modulo bias over a small set is ~1e-10),
// but its INPUT is low-entropy and a MINER CAN GRIND THE BLOCK TIMESTAMP to bias
// the result. That is acceptable for low-value card packs; for high-value
// randomness use commit-reveal or an attestation oracle (xchain.attestation).
// The block hash is the SAME for every tx in a block, so draw() mixes in the
// buyer address and a per-contract draw counter (nonce) to de-correlate
// same-block draws.
//
// SOLD OUT: when every card is at 0 copies the payment is REFUNDED rather than
// reverting. A reverted EXECUTE would NOT roll back the DEPOSIT batched before
// it, which would strand the buyer's payment in the contract.
// ---------------------------------------------------------------------------

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/contract-abi.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        draw:     { summary: 'Buy one draw: sends a random in-stock card weighted by copies held, refunding if sold out (BATCH after a DEPOSIT of price)', params: [] },
        withdraw: { summary: 'OWNER ONLY: sweeps the contract\'s entire balance of tick (proceeds, or leftover/retired cards)', params: [ { name: 'tick', type: 'tick' } ] },
        info:     { summary: 'Read the pay tick, price, unit, draw count, and remaining stock per card', params: [], view: true }
    } },

    // initialize(payTick, price, unit, card1, card2, ...)
    // payTick : the tick the buyer pays in.
    // price   : amount of payTick required per draw (> 0).
    // unit    : amount of a card sent per draw, e.g. "1.00000000" (> 0).
    // cardN   : the candidate card ticks (at least one).
    initialize: function (xchain) {
        var payTick = xchain.getInputParam(0);
        var price   = xchain.getInputParam(1);
        var unit    = xchain.getInputParam(2);

        xchain.require(payTick, 'payTick required');
        xchain.require(price && xchain.math.gt(price, '0'), 'price must be > 0');
        xchain.require(unit && xchain.math.gt(unit, '0'), 'unit must be > 0');

        var count = xchain.getInputParamCount();
        xchain.require(count > 3, 'at least one card tick required');

        var cards = [];
        for (var i = 3; i < count; i++) {
            var t = xchain.getInputParam(i);
            // "|" is the wire delimiter for the joined card list in state.
            xchain.require(t && t.indexOf('|') === -1, 'invalid card tick');
            xchain.require(t !== payTick, 'card tick must differ from payTick');
            cards.push(t);
        }

        xchain.state.set('owner', xchain.getSourceAddress());
        xchain.state.set('payTick', payTick);
        xchain.state.set('price', price);
        xchain.state.set('unit', unit);
        xchain.state.set('cards', cards.join('|'));
        xchain.state.set('acctPay', '0');   // last accounted payTick balance
        xchain.state.set('nonce', '0');     // per-contract draw counter (entropy)
    },

    // draw(): typically BATCHed after a DEPOSIT of `price` payTick. Sends one
    // random in-stock card (weighted by copies held) to the buyer, or refunds
    // the payment when everything is sold out.
    draw: function (xchain) {
        var self    = xchain.getContractAddress();
        var buyer   = xchain.getSourceAddress();
        var payTick = xchain.state.get('payTick');
        var price   = xchain.state.get('price');
        var unit    = xchain.state.get('unit');

        // --- Payment: delta of the contract's payTick balance since last draw ---
        var curPay = xchain.getBalance(self, payTick) || '0';
        var paid   = xchain.math.subtract(curPay, xchain.state.get('acctPay'));
        xchain.require(xchain.math.gte(paid, price), 'underpaid');

        // --- Build the in-stock weighted inventory: copies = floor(balance / unit) ---
        var cards   = xchain.state.get('cards').split('|');
        var weights = [];
        var total   = '0';
        for (var i = 0; i < cards.length; i++) {
            var bal    = xchain.getBalance(self, cards[i]) || '0';
            var q      = xchain.math.divide(bal, unit);
            var copies = xchain.math.subtract(q, xchain.math.mod(q, '1')); // floor (>=0)
            weights.push(copies);
            total = xchain.math.add(total, copies);
        }

        // --- Sold out: refund instead of reverting (see header) ---
        if (xchain.math.isZero(total)) {
            xchain.emit.send({ destination: buyer, tick: payTick, quantity: paid });
            // The refund takes `paid` back OUT of custody, so the watermark lands on
            // the post-refund balance. Advancing it to curPay would over-count by
            // exactly the refund and under-measure every later payment.
            xchain.state.set('acctPay', xchain.math.subtract(curPay, paid));
            return 'sold_out';
        }

        // --- Deterministic uniform pick in [0, total), then map to a card ---
        var r = pick(xchain, buyer, total);
        var acc = '0';
        var chosen = null;
        for (var j = 0; j < cards.length; j++) {
            acc = xchain.math.add(acc, weights[j]);
            if (xchain.math.lt(r, acc)) { chosen = cards[j]; break; }
        }
        xchain.require(chosen !== null, 'selection failed'); // unreachable: r < total

        // --- Dispense + advance accounting ---
        xchain.emit.send({ destination: buyer, tick: chosen, quantity: unit });
        xchain.state.set('acctPay', curPay);  // any overpayment is kept (tip)
        xchain.state.set('nonce', xchain.math.add(xchain.state.get('nonce'), '1'));
        return chosen;
    },

    // withdraw(tick): owner sweeps the contract's entire balance of `tick`
    // (collect proceeds in payTick, or pull leftover/retired cards).
    withdraw: function (xchain) {
        xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'owner only');
        var tick = xchain.getInputParam(0);
        xchain.require(tick, 'tick required');
        var held = xchain.getBalance(xchain.getContractAddress(), tick) || '0';
        xchain.require(xchain.math.gt(held, '0'), 'nothing to withdraw');
        xchain.emit.send({ destination: xchain.state.get('owner'), tick: tick, quantity: held });
        // A sweep of payTick empties it, so draw()'s watermark has to follow custody
        // down to 0 or the next draw measures a negative delta and reverts forever.
        if (tick === xchain.state.get('payTick')) xchain.state.set('acctPay', '0');
    },

    // info(): read-only snapshot of remaining stock per card.
    info: function (xchain) {
        var self  = xchain.getContractAddress();
        var unit  = xchain.state.get('unit');
        var cards = xchain.state.get('cards').split('|');
        var stock = {};
        for (var i = 0; i < cards.length; i++) {
            var q = xchain.math.divide(xchain.getBalance(self, cards[i]) || '0', unit);
            stock[cards[i]] = xchain.math.subtract(q, xchain.math.mod(q, '1'));
        }
        return JSON.stringify({
            payTick: xchain.state.get('payTick'),
            price:   xchain.state.get('price'),
            unit:    unit,
            draws:   xchain.state.get('nonce'),
            stock:   stock
        });
    }
};

// Deterministic pseudo-random integer in [0, total). Entropy is the block hash,
// folded char-by-char so it works whether the host gives a 64-hex sha256 (real
// indexer) or any other string (test harness). Mixed with the buyer address and
// the per-contract nonce so two draws in the same block never collide by
// construction. See the RANDOMNESS note in the header for the security caveat.
function pick(xchain, buyer, total) {
    var MOD   = '100000000000000000000000000000000000000'; // 1e38, >> any realistic total
    var seed  = fold(xchain, xchain.getBlockHash() || '', MOD);
    var addr  = fold(xchain, buyer, MOD);
    var nonce = xchain.state.get('nonce');
    // mix = seed + addr*P1 + nonce*P2  (two large odd constants for diffusion)
    var mix = xchain.math.add(
        seed,
        xchain.math.add(
            xchain.math.multiply(addr, '1000000007'),
            xchain.math.multiply(nonce, '6364136223846793005')
        )
    );
    return xchain.math.mod(mix, total);
}

// Horner fold of a string into a bounded big integer in [0, MOD).
function fold(xchain, s, MOD) {
    var acc = '0';
    for (var i = 0; i < s.length; i++) {
        acc = xchain.math.mod(
            xchain.math.add(xchain.math.multiply(acc, '131'), String(s.charCodeAt(i))),
            MOD
        );
    }
    return acc;
}
