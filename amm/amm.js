// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// amm.js: constant-product automated market maker (Uniswap-v2 style)
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
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. See the MIT
// License for the full text.
//
// ---------------------------------------------------------------------------
// WHAT THIS IS
//
// A two-token automated market maker holding a pool of tokenA and tokenB and
// pricing swaps by the constant-product rule (reserveA * reserveB = k). Liquidity
// providers deposit both tokens and receive LP-share tokens; swappers trade one
// token for the other, paying a 0.3% fee that accrues to the pool (and thus to LP
// holders). LP shares are a REAL contract-issued tick (transferable, visible in
// the explorer, and tradeable on XChain's native orderbook DEX).
//
// Why an AMM as a contract? XChain has a native orderbook DEX (ORDER/SWAP), but
// orderbooks have thin long-tail liquidity. An AMM is the textbook complement:
// shipping it as a plain contract proves the VM's custody model is real and
// general-purpose.
//
// KEY INVARIANT: k (reserveA * reserveB) is non-decreasing across swaps. This
// holds because the FULL input, including the 0.3% fee, is added to reserves while
// the price credits the trader for only 99.7% of it. xchain.math is 64-significant-
// digit bignumber (it rounds at that precision, NOT Solidity-style integer floor),
// so per-op rounding is negligible beside the fee; the fee is what guarantees the
// pool grows. This is the property to fuzz.
//
// CUSTODY MODEL (and its footgun)
//
// XChain has no msg.value. Move tokens in via DEPOSIT, act via EXECUTE, atomically
// with BATCH. Example swap:
//
//     BATCH( DEPOSIT(pool, tokenIn, amount), EXECUTE(pool, "swap", tokenIn, minOut) )
//
// Each entrypoint credits the caller by the balance delta since the last accounted
// reserve, so it MUST be atomic with the deposit. Tokens sent to the pool address
// outside a BATCHed call are credited to whoever calls next. Reserves are tracked
// in state (not raw balance), so direct donations don't move the price.
//
// LP TICK NAMING: the contract issues `lpTick` at deploy and becomes its owner.
// Pick an UNUSED name (ticks are a global namespace). A collision makes the
// constructor's issue fail and the whole deploy revert (fail-fast, so two pools
// can never share an LP tick). Convention: "<TICKA><TICKB>LP".
// ---------------------------------------------------------------------------

var FEE_NUM = '997';   // 0.3% fee: keep 99.7% of the input in the pricing math
var FEE_DEN = '1000';

// LP shares are issued with 8 decimals (see initialize); share math is quantised to
// this same grid before it touches state or an emission.
var LP_DECIMALS = 8;

// RESERVE RECONCILIATION (see finding: reserves/totalShares drift)
//
// xchain.math computes at 64 significant digits, but the indexer normalises every
// emitted amount to its tick's decimals at ledger-write time (util.bcadd -> mathjs
// half-even round). So a computed share/payout written to state at full precision is
// MORE precise than the LP or tokens the ledger actually mints/moves: state drifts
// above real custody, totalShares inflates, and the last LP can never drain the pool.
//
// Fix: quantise every computed quantity DOWN to its tick's decimal grid BEFORE both
// the state write and the emission. Once a value has <= `decimals` fraction digits the
// indexer's re-normalisation is a numeric no-op, so state stays reconciled with
// custody. Rounding DOWN (never up) guarantees the pool never credits/pays more than it
// holds and keeps k non-decreasing.
//
// The truncation is pure string surgery on the fixed-notation decimal xchain.math
// returns: it is exact and deterministic, and it deliberately avoids mathjs floor/mod,
// which round a large bignumber to the configured significant-digit precision (not the
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

// Decimals of a tick the pool custodies, read from the ledger snapshot. The pool always
// holds the tokens it pays out (reserves) and receives (deposits), so their token info
// is present whenever balances are (same VM_BALANCE_TOKENINFO gate getBalance rides on).
function tickDecimals(xchain, tick) {
    var info = xchain.getTokenInfo(tick);
    xchain.require(info && info.DECIMALS !== null && info.DECIMALS !== undefined,
        'token decimals unavailable: ' + tick);
    return info.DECIMALS;
}

module.exports = {

    // Self-declared display metadata for wallets/explorers (spec:
    // xchain-documentation/protocol/Contract_ABI.md). Advisory only; never
    // read by the VM or indexer, and not verified against the code.
    abi: { version: 1, methods: {
        addLiquidity:    { summary: 'Mint LP shares for deposited liquidity (BATCH after DEPOSITing both tokens)', params: [] },
        removeLiquidity: { summary: 'Burn LP shares and withdraw both tokens (BATCH after DEPOSITing LP shares)', params: [] },
        swap:            { summary: 'Trade tokenIn for the other token at the constant-product price, 0.3% fee (BATCH after a DEPOSIT)', params: [ { name: 'tokenIn', type: 'tick' }, { name: 'minOut', type: 'amount' } ] },
        info:            { summary: 'Read the pair, reserves, and total LP shares', params: [], view: true }
    } },

    // initialize(tokenA, tokenB, lpTick): create an empty pool and issue the LP tick.
    initialize: function (xchain) {
        var tokenA = xchain.getInputParam(0);
        var tokenB = xchain.getInputParam(1);
        var lpTick = xchain.getInputParam(2);

        xchain.require(tokenA && tokenB && lpTick, 'tokenA, tokenB, lpTick required');
        xchain.require(tokenA !== tokenB, 'tokenA and tokenB must differ');
        xchain.require(lpTick !== tokenA && lpTick !== tokenB, 'lpTick must differ from the pair');

        xchain.state.set('tokenA', tokenA);
        xchain.state.set('tokenB', tokenB);
        xchain.state.set('lpTick', lpTick);
        xchain.state.set('reserveA', '0');
        xchain.state.set('reserveB', '0');
        xchain.state.set('totalShares', '0');

        // A name collision on lpTick reverts the deploy (fail-fast by design).
        var big = '99999999999999999999';
        xchain.emit.issue({ tick: lpTick, maxSupply: big, maxMint: big, decimals: String(LP_DECIMALS), description: 'AMM LP share' });
    },

    // addLiquidity(): BATCH after DEPOSITing both tokenA and tokenB. Mints LP
    // shares to the provider proportional to the deposit.
    addLiquidity: function (xchain) {
        var self = xchain.getContractAddress();
        var tokenA = xchain.state.get('tokenA');
        var tokenB = xchain.state.get('tokenB');
        var reserveA = xchain.state.get('reserveA');
        var reserveB = xchain.state.get('reserveB');
        var totalShares = xchain.state.get('totalShares');

        var depA = xchain.math.subtract(xchain.getBalance(self, tokenA) || '0', reserveA);
        var depB = xchain.math.subtract(xchain.getBalance(self, tokenB) || '0', reserveB);
        xchain.require(xchain.math.gt(depA, '0') && xchain.math.gt(depB, '0'), 'must deposit both tokens');

        var shares;
        if (xchain.math.isZero(totalShares)) {
            // First provider sets the price; initial shares = sqrt(depA * depB).
            shares = xchain.math.sqrt(xchain.math.multiply(depA, depB));
        } else {
            // Proportional to the scarcer side, so skewed deposits can't mint extra
            // shares; any excess on the other side simply enriches the pool. Deposit
            // in the current reserve ratio to avoid donating the surplus.
            var sA = xchain.math.divide(xchain.math.multiply(depA, totalShares), reserveA);
            var sB = xchain.math.divide(xchain.math.multiply(depB, totalShares), reserveB);
            shares = xchain.math.min(sA, sB);
        }
        // Quantise to the LP grid so state totalShares matches the LP the indexer mints.
        shares = floorToDecimals(shares, LP_DECIMALS);
        xchain.require(xchain.math.gt(shares, '0'), 'insufficient liquidity minted');

        xchain.state.set('reserveA', xchain.math.add(reserveA, depA));
        xchain.state.set('reserveB', xchain.math.add(reserveB, depB));
        xchain.state.set('totalShares', xchain.math.add(totalShares, shares));

        xchain.emit.mint({ tick: xchain.state.get('lpTick'), quantity: shares, destination: xchain.getSourceAddress() });
        return shares;
    },

    // removeLiquidity(): BATCH after DEPOSITing LP shares back to the pool.
    // Burns them and returns a proportional slice of both reserves.
    removeLiquidity: function (xchain) {
        var self = xchain.getContractAddress();
        var lpTick = xchain.state.get('lpTick');
        var tokenA = xchain.state.get('tokenA');
        var tokenB = xchain.state.get('tokenB');
        var reserveA = xchain.state.get('reserveA');
        var reserveB = xchain.state.get('reserveB');
        var totalShares = xchain.state.get('totalShares');

        var shares = xchain.getBalance(self, lpTick) || '0';
        xchain.require(xchain.math.gt(shares, '0'), 'must deposit LP shares');
        xchain.require(xchain.math.lte(shares, totalShares), 'shares exceed total');

        // Quantise each payout DOWN to its token grid so the state debit matches the
        // amount the indexer actually sends from custody (dust favours the pool).
        var outA = floorToDecimals(xchain.math.divide(xchain.math.multiply(reserveA, shares), totalShares), tickDecimals(xchain, tokenA));
        var outB = floorToDecimals(xchain.math.divide(xchain.math.multiply(reserveB, shares), totalShares), tickDecimals(xchain, tokenB));
        xchain.require(xchain.math.gt(outA, '0') && xchain.math.gt(outB, '0'), 'insufficient liquidity burned');

        xchain.state.set('reserveA', xchain.math.subtract(reserveA, outA));
        xchain.state.set('reserveB', xchain.math.subtract(reserveB, outB));
        xchain.state.set('totalShares', xchain.math.subtract(totalShares, shares));

        xchain.emit.destroy({ tick: lpTick, quantity: shares });

        var to = xchain.getSourceAddress();
        xchain.emit.send({ destination: to, tick: tokenA, quantity: outA });
        xchain.emit.send({ destination: to, tick: tokenB, quantity: outB });
        return JSON.stringify({ outA: outA, outB: outB });
    },

    // swap(tokenIn, minOut): BATCH after DEPOSITing `tokenIn`. Trades for the other
    // token at the constant-product price, charging 0.3%, reverting if the output
    // would fall below `minOut` (slippage protection).
    swap: function (xchain) {
        var tokenIn = xchain.getInputParam(0);
        var minOut  = xchain.getInputParam(1) || '0';

        var self = xchain.getContractAddress();
        var tokenA = xchain.state.get('tokenA');
        var tokenB = xchain.state.get('tokenB');
        xchain.require(tokenIn === tokenA || tokenIn === tokenB, 'tokenIn not in pair');

        var inIsA = (tokenIn === tokenA);
        var tokenOut = inIsA ? tokenB : tokenA;
        var reserveIn  = inIsA ? xchain.state.get('reserveA') : xchain.state.get('reserveB');
        var reserveOut = inIsA ? xchain.state.get('reserveB') : xchain.state.get('reserveA');
        xchain.require(xchain.math.gt(reserveIn, '0') && xchain.math.gt(reserveOut, '0'), 'no liquidity');

        var amountIn = xchain.math.subtract(xchain.getBalance(self, tokenIn) || '0', reserveIn);
        xchain.require(xchain.math.gt(amountIn, '0'), 'no input received (DEPOSIT in the same BATCH)');

        // Uniswap-v2 pricing: the trader is credited for 99.7% of the input
        // (amountInWithFee), but the FULL input is retained in reserves. That
        // 0.3% gap is the LP fee and is what makes k grow.
        var amountInWithFee = xchain.math.divide(xchain.math.multiply(amountIn, FEE_NUM), FEE_DEN);
        // Quantise the output DOWN to the out-token grid before the reserve write + send,
        // so state reserveOut stays reconciled with real custody and k never decreases.
        var amountOut = floorToDecimals(xchain.math.divide(
            xchain.math.multiply(reserveOut, amountInWithFee),
            xchain.math.add(reserveIn, amountInWithFee)
        ), tickDecimals(xchain, tokenOut));
        xchain.require(xchain.math.gt(amountOut, '0'), 'insufficient output');
        xchain.require(xchain.math.lt(amountOut, reserveOut), 'output exceeds reserves');
        xchain.require(xchain.math.gte(amountOut, minOut), 'slippage: output below minOut');

        var newIn  = xchain.math.add(reserveIn, amountIn);
        var newOut = xchain.math.subtract(reserveOut, amountOut);
        xchain.state.set(inIsA ? 'reserveA' : 'reserveB', newIn);
        xchain.state.set(inIsA ? 'reserveB' : 'reserveA', newOut);

        xchain.emit.send({ destination: xchain.getSourceAddress(), tick: tokenOut, quantity: amountOut });
        return amountOut;
    },

    info: function (xchain) {
        return JSON.stringify({
            tokenA: xchain.state.get('tokenA'),
            tokenB: xchain.state.get('tokenB'),
            lpTick: xchain.state.get('lpTick'),
            reserveA: xchain.state.get('reserveA'),
            reserveB: xchain.state.get('reserveB'),
            totalShares: xchain.state.get('totalShares')
        });
    }
};
