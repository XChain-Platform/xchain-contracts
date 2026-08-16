// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// stableVault.js: a mini-MakerDAO -- over-collateralized stablecoin vaults
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED. See the MIT License for the full text.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// A single-collateral stablecoin engine, MakerDAO-style. Anyone opens a vault
// by depositing the collateral token; against that collateral the CONTRACT
// mints its own stable token (emit.mint into custody, emit.send to the
// borrower) as debt, as long as the vault stays over-collateralized against
// the PRICE oracle:
//
//     collateral * price * 100  >=  debt * minRatioPct
//
// Repaying burns the stable (emit.destroy). If the oracle price falls and a
// vault drops below the minimum ratio, ANYONE can liquidate it: the
// liquidator deposits stable covering the full debt (burned) and seizes
// collateral worth debt * (100 + liqBonusPct)% at the oracle price. Whatever
// collateral is left after the seizure still belongs to the vault owner.
//
// CUSTODY AND ATTRIBUTION
//
// There is no msg.value on XChain. Tokens enter via DEPOSIT to the contract's
// address; logic runs via EXECUTE. Fund-and-act atomically with BATCH:
//
//     BATCH [ DEPOSIT(collateral -> vault) , EXECUTE deposit() ]
//
// A DEPOSIT carries no sender attribution, so the contract attributes by
// DELTA: it tracks the total collateral and stable it has accounted for
// (trackedColl / trackedStable) and credits the caller of the batched EXECUTE
// with (actual custody - tracked total). The on-chain balance is the source
// of truth; caller-supplied amounts are never trusted for funding.
//
// ORACLE
//
// getPrice(coinPair) is the latest consensus-finalized round, as the object
// { price, roundNumber, timestamp } (a bare string price is also accepted).
// Price-sensitive operations (borrow, withdraw, liquidate) additionally
// require getSnapshotAge() <= maxSnapshotAge blocks, so nobody can act on a
// stale price during an oracle outage. Deposits and repayments are always
// allowed -- de-risking a vault must never be blocked.
//
// NOT PRODUCTION-GRADE ON PURPOSE. A real system adds stability fees, partial
// liquidations, auctions, debt ceilings, and multiple collateral types. This
// template shows the mechanism in its smallest deterministic form.

'use strict';

module.exports = {

    // initialize(collateralTick, stableTick, coinPair, minRatioPct,
    //            liqBonusPct, maxSnapshotAge)
    //
    //   collateralTick  token accepted as collateral (e.g. 'XCHAIN')
    //   stableTick      token this contract mints as debt (e.g. 'DUSD')
    //   coinPair        oracle pair pricing 1 collateral in stable units
    //   minRatioPct     minimum collateralization, percent (e.g. '150')
    //   liqBonusPct     liquidator's bonus over the debt, percent (e.g. '10')
    //   maxSnapshotAge  max oracle age (blocks) for price-sensitive ops
    initialize: function (xchain) {
        var collateralTick = xchain.getInputParam(0);
        var stableTick     = xchain.getInputParam(1);
        var coinPair       = xchain.getInputParam(2);
        var minRatioPct    = xchain.getInputParam(3);
        var liqBonusPct    = xchain.getInputParam(4);
        var maxSnapshotAge = xchain.getInputParam(5);

        xchain.require(collateralTick, 'collateralTick required');
        xchain.require(stableTick, 'stableTick required');
        xchain.require(collateralTick !== stableTick, 'collateral and stable must differ');
        xchain.require(coinPair, 'coinPair required');
        // Below 100% the "stable" would be under-backed by construction.
        xchain.require(minRatioPct && xchain.math.gt(minRatioPct, '100'),
            'minRatioPct must exceed 100');
        xchain.require(liqBonusPct && xchain.math.gte(liqBonusPct, '0'),
            'liqBonusPct must be >= 0');
        var maxAge = parseInt(maxSnapshotAge);
        xchain.require(maxAge > 0, 'maxSnapshotAge must be a positive integer');

        xchain.state.set('collateralTick', collateralTick);
        xchain.state.set('stableTick', stableTick);
        xchain.state.set('coinPair', coinPair);
        xchain.state.set('minRatioPct', minRatioPct);
        xchain.state.set('liqBonusPct', liqBonusPct);
        xchain.state.set('maxSnapshotAge', String(maxAge));
        xchain.state.set('trackedColl', '0');
        xchain.state.set('trackedStable', '0');
        xchain.state.set('totalDebt', '0');

        // Register the stable token with this contract as its issuer. Every
        // unit in existence is minted here against collateral and burned on
        // repay/liquidation -- the contract IS the monetary policy. maxSupply
        // must be declared: the indexer rejects any MINT on a token whose cap
        // is unset (it reads as 0).
        xchain.emit.issue({ tick: stableTick, maxSupply: '1000000000' });
    },

    // deposit(): credit the caller's vault with the collateral that arrived
    // in this batch (custody delta). BATCHed after a DEPOSIT of collateral.
    // Always allowed: adding collateral only ever makes a vault safer.
    deposit: function (xchain) {
        var addr  = xchain.getSourceAddress();
        var delta = collDelta(xchain);
        xchain.require(xchain.math.gt(delta, '0'), 'no collateral received');

        setVault(xchain, addr, 'coll', xchain.math.add(getVault(xchain, addr, 'coll'), delta));
        xchain.state.set('trackedColl', xchain.math.add(xchain.state.get('trackedColl'), delta));
    },

    // borrow(amount): mint `amount` of the stable against the caller's vault.
    // The vault must remain at/above the minimum ratio AFTER the new debt.
    borrow: function (xchain) {
        var addr   = xchain.getSourceAddress();
        var amount = xchain.getInputParam(0);
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        // Notation gate, and it must come BEFORE the floor below. `amount` is raw
        // per-call caller text, so unlike liquidate()'s mathjs-computed seizure it
        // is not guaranteed fixed-notation, and math.gt() is no filter at all (see
        // requirePlainDecimal). Fed '1.5e-8' the floor silently NO-OPS and the
        // off-grid debt reaches the books and the wire anyway.
        requirePlainDecimal(xchain, amount, 'amount');
        // Quantise onto the stable tick's grid BEFORE the ratio check, the debt
        // book writes, and the emissions. The indexer ROUNDS emission amounts to
        // the tick's decimals on the wire; an off-grid `amount` would book raw
        // but round up when minted/sent, leaving a debt the borrower can never
        // repay to exactly '0' (residual dust locks collateral via ratioOk).
        // Same guard liquidate() applies to the collateral tick.
        amount = floorToDecimals(amount, tickDecimals(xchain, xchain.state.get('stableTick')));
        xchain.require(xchain.math.gt(amount, '0'), 'amount must be positive after tick rounding');

        var price   = freshPrice(xchain);
        var coll    = getVault(xchain, addr, 'coll');
        var newDebt = xchain.math.add(getVault(xchain, addr, 'debt'), amount);
        xchain.require(ratioOk(xchain, coll, newDebt, price), 'vault would be under-collateralized');

        setVault(xchain, addr, 'debt', newDebt);
        xchain.state.set('totalDebt', xchain.math.add(xchain.state.get('totalDebt'), amount));

        // Mint into custody, then pay out. Net custody change of the stable
        // is zero, so trackedStable is untouched.
        xchain.emit.mint({ tick: xchain.state.get('stableTick'), quantity: amount });
        xchain.emit.send({
            destination: addr,
            tick: xchain.state.get('stableTick'),
            quantity: amount
        });
    },

    // repay(): burn the stable that arrived in this batch against the
    // caller's debt; anything beyond the debt is returned. BATCHed after a
    // DEPOSIT of the stable. Always allowed (no oracle involved).
    repay: function (xchain) {
        var addr     = xchain.getSourceAddress();
        var received = stableDelta(xchain);
        xchain.require(xchain.math.gt(received, '0'), 'no stable received');

        var debt   = getVault(xchain, addr, 'debt');
        var burned = xchain.math.min(received, debt);
        var excess = xchain.math.subtract(received, burned);

        setVault(xchain, addr, 'debt', xchain.math.subtract(debt, burned));
        xchain.state.set('totalDebt', xchain.math.subtract(xchain.state.get('totalDebt'), burned));

        if (xchain.math.gt(burned, '0')) {
            xchain.emit.destroy({ tick: xchain.state.get('stableTick'), quantity: burned });
        }
        if (xchain.math.gt(excess, '0')) {
            xchain.emit.send({
                destination: addr,
                tick: xchain.state.get('stableTick'),
                quantity: excess
            });
        }
    },

    // withdraw(amount): take collateral out of the caller's vault. The vault
    // must remain at/above the minimum ratio afterwards (debt-free vaults can
    // withdraw everything; no oracle read is needed for them).
    withdraw: function (xchain) {
        var addr   = xchain.getSourceAddress();
        var amount = xchain.getInputParam(0);
        xchain.require(amount && xchain.math.gt(amount, '0'), 'amount must be positive');
        // Notation gate before the floor, same reason as borrow(): raw caller text
        // spelled '1.5e-8' walks straight through math.gt AND through the floor
        // (its fraction is 4 chars, under the grid), so trackedColl would be
        // debited the raw value while custody moves the HALF-UP rounded one.
        requirePlainDecimal(xchain, amount, 'amount');
        // Quantise onto the collateral tick's grid BEFORE the ratio check, the
        // book writes, and the emission. The indexer ROUNDS the emitted quantity
        // to the tick's decimals; an off-grid `amount` would debit trackedColl
        // by the raw value while custody moves the rounded-up value, opening a
        // pooled custody-vs-books shortfall (and cascading through collDelta).
        // Same guard liquidate() applies to its seize amount.
        amount = floorToDecimals(amount, tickDecimals(xchain, xchain.state.get('collateralTick')));
        xchain.require(xchain.math.gt(amount, '0'), 'amount must be positive after tick rounding');

        var coll = getVault(xchain, addr, 'coll');
        xchain.require(xchain.math.gte(coll, amount), 'insufficient collateral');
        var left = xchain.math.subtract(coll, amount);

        var debt = getVault(xchain, addr, 'debt');
        if (xchain.math.gt(debt, '0')) {
            var price = freshPrice(xchain);
            xchain.require(ratioOk(xchain, left, debt, price), 'vault would be under-collateralized');
        }

        setVault(xchain, addr, 'coll', left);
        xchain.state.set('trackedColl', xchain.math.subtract(xchain.state.get('trackedColl'), amount));

        xchain.emit.send({
            destination: addr,
            tick: xchain.state.get('collateralTick'),
            quantity: amount
        });
    },

    // liquidate(vaultOwner): permissionless. If the vault is BELOW the
    // minimum ratio at the fresh oracle price, the caller's batched stable
    // deposit covers the full debt (burned) and the caller seizes collateral
    // worth debt * (100 + liqBonusPct)% at that price, capped at the vault's
    // collateral. Leftover collateral stays credited to the vault owner; any
    // stable sent beyond the debt is returned to the liquidator.
    liquidate: function (xchain) {
        var liquidator = xchain.getSourceAddress();
        var owner      = xchain.getInputParam(0);
        xchain.require(owner, 'vaultOwner required');
        xchain.require(liquidator !== owner, 'cannot liquidate your own vault');

        var debt = getVault(xchain, owner, 'debt');
        xchain.require(xchain.math.gt(debt, '0'), 'vault has no debt');

        var price = freshPrice(xchain);
        var coll  = getVault(xchain, owner, 'coll');
        xchain.require(!ratioOk(xchain, coll, debt, price), 'vault is healthy');

        var received = stableDelta(xchain);
        xchain.require(xchain.math.gte(received, debt), 'must cover the full debt');
        var excess = xchain.math.subtract(received, debt);

        // Collateral owed to the liquidator: debt * (100 + bonus) / (price * 100),
        // capped at what the vault actually holds.
        var owed  = xchain.math.divide(
            xchain.math.multiply(debt, xchain.math.add('100', xchain.state.get('liqBonusPct'))),
            xchain.math.multiply(price, '100')
        );
        // Quantise the seizure DOWN to the collateral tick's decimal grid
        // BEFORE the state writes and the emission. The indexer re-rounds every
        // emitted amount to the tick's decimals HALF-UP at ledger-write time
        // (the indexer's bcmath rounds half-up, NOT half-even: the mode is
        // stated in xchain-indexer/src/xchainPrice.js and pinned by test,
        // because a mis-read mode at the .5 boundary is a consensus fork);
        // an off-grid seize written exactly into trackedColl/vault books but
        // rounded UP on the wire would debit custody more than books, opening a
        // pooled shortfall other vaults would eat (bad-debt DoS on the last
        // full-balance withdrawal). Flooring makes the indexer's normalisation
        // a numeric no-op, so custody == books holds exactly.
        var seize = floorToDecimals(
            xchain.math.min(owed, coll),
            tickDecimals(xchain, xchain.state.get('collateralTick'))
        );

        setVault(xchain, owner, 'debt', '0');
        setVault(xchain, owner, 'coll', xchain.math.subtract(coll, seize));
        xchain.state.set('totalDebt', xchain.math.subtract(xchain.state.get('totalDebt'), debt));
        xchain.state.set('trackedColl', xchain.math.subtract(xchain.state.get('trackedColl'), seize));

        xchain.emit.destroy({ tick: xchain.state.get('stableTick'), quantity: debt });
        xchain.emit.send({
            destination: liquidator,
            tick: xchain.state.get('collateralTick'),
            quantity: seize
        });
        if (xchain.math.gt(excess, '0')) {
            xchain.emit.send({
                destination: liquidator,
                tick: xchain.state.get('stableTick'),
                quantity: excess
            });
        }
    },

    // vault(addr): a vault's collateral and debt, JSON-encoded.
    vault: function (xchain) {
        var addr = xchain.getInputParam(0);
        xchain.require(addr, 'address required');
        return JSON.stringify({
            collateral: getVault(xchain, addr, 'coll'),
            debt:       getVault(xchain, addr, 'debt')
        });
    },

    // info(): system terms and totals, JSON-encoded.
    info: function (xchain) {
        return JSON.stringify({
            collateralTick: xchain.state.get('collateralTick'),
            stableTick:     xchain.state.get('stableTick'),
            coinPair:       xchain.state.get('coinPair'),
            minRatioPct:    xchain.state.get('minRatioPct'),
            liqBonusPct:    xchain.state.get('liqBonusPct'),
            maxSnapshotAge: xchain.state.get('maxSnapshotAge'),
            totalDebt:      xchain.state.get('totalDebt'),
            trackedColl:    xchain.state.get('trackedColl')
        });
    }
};

// --- helpers -------------------------------------------------------------

// Per-vault state, namespaced by address. Missing keys read as '0'.
function getVault(xchain, addr, field) {
    return xchain.state.get('v:' + addr + ':' + field) || '0';
}
function setVault(xchain, addr, field, value) {
    xchain.state.set('v:' + addr + ':' + field, value);
}

// Un-attributed collateral / stable sitting in custody: actual balance minus
// what the ledger has already accounted for. This is what a batched DEPOSIT
// just delivered.
function collDelta(xchain) {
    var held = xchain.getBalance(xchain.getContractAddress(), xchain.state.get('collateralTick')) || '0';
    return xchain.math.subtract(held, xchain.state.get('trackedColl'));
}
function stableDelta(xchain) {
    // trackedStable is structurally '0' (mint+send net out in the same run),
    // but subtracting it keeps the invariant explicit and future-proof.
    var held = xchain.getBalance(xchain.getContractAddress(), xchain.state.get('stableTick')) || '0';
    return xchain.math.subtract(held, xchain.state.get('trackedStable'));
}

// Latest oracle price for the configured pair, as a string. Accepts both the
// production accessor's { price, roundNumber, timestamp } object and a bare
// string. Reverts if there is no price or the snapshot is older than
// maxSnapshotAge blocks.
function freshPrice(xchain) {
    var age = xchain.oracle.getSnapshotAge();
    xchain.require(age <= parseInt(xchain.state.get('maxSnapshotAge')), 'oracle price is stale');

    var r = xchain.oracle.getPrice(xchain.state.get('coinPair'));
    xchain.require(r !== null && r !== undefined, 'no oracle price for pair');
    var price = (typeof r === 'object') ? r.price : r;
    xchain.require(price !== null && price !== undefined, 'no oracle price for pair');
    price = String(price);
    xchain.require(xchain.math.gt(price, '0'), 'oracle price must be positive');
    return price;
}

// Reject any spelling of a numeric term that is not a plain fixed-notation
// decimal: digits, with at most one decimal point that has digits on both sides.
// Same helper and rationale as priceBet.js:requirePlainDecimal.
//
// floorToDecimals below is string surgery that PRESUPPOSES fixed notation. Every
// value liquidate() feeds it was computed by xchain.math, and the VM formats every
// math result in fixed notation (xchain-vm/src/math.js toFixed), so the
// precondition is free there. borrow()/withdraw() are different: their `amount` is
// raw per-call caller text, and `xchain.math.gt(x, '0')` accepts every spelling
// mathjs parses -- exponential ('1.5e-8'), radix prefixes ('0x10'), numeric
// separators ('1_000'), a leading '+', a bare leading dot, 'Infinity'. Fed
// '1.5e-8' the floor no-ops (the fraction '5e-8' is 4 chars, under an 8-decimal
// grid, so the already-on-grid early return fires), the raw off-grid value is
// written to the vault books and emitted, and the indexer re-rounds the wire
// amount HALF-UP to 0.00000002 while the books say 0.000000015: half a base unit
// of pooled custody-versus-books shortfall, on EVERY call, which is exactly the
// drift the liquidate() comment above warns about.
//
// This is NOT a grid check and does not replace the floor: '0.000000015' is
// legitimately spelled and still off an 8-decimal grid. Notation is checked here;
// the grid is checked there.
//
// No RegExp: the VM's syntax validator bans RegExp literals in contract source, so
// this is a character walk. The loop is gas-metered per iteration, so an oversized
// param exhausts the caller's own gas rather than costing anyone else.
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

// Truncate a fixed-notation decimal string DOWN to `decimals` fraction digits.
// Pure string surgery (same helper as amm.js/crowdsale.js): exact and
// deterministic, and it deliberately avoids mathjs floor/mod, which round a
// large bignumber to the configured significant-digit precision (not the
// decimal grid) and would corrupt the result.
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

// Decimals of a tick the vault custodies, read from the ledger snapshot. The
// contract always holds the collateral it seizes, so its token info is present
// whenever balances are (same gate getBalance rides on).
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}

// Collateralization check without division:
//     coll * price * 100  >=  debt * minRatioPct
// Zero debt is always healthy.
function ratioOk(xchain, coll, debt, price) {
    if (!xchain.math.gt(debt, '0')) return true;
    var lhs = xchain.math.multiply(xchain.math.multiply(coll, price), '100');
    var rhs = xchain.math.multiply(debt, xchain.state.get('minRatioPct'));
    return xchain.math.gte(lhs, rhs);
}
