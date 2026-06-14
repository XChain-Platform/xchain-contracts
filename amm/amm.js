// SPDX-License-Identifier: MIT
//
// XChain Platform — Contract Template Library
// amm.js — constant-product automated market maker (Uniswap-v2 style)
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
// holders). LP shares are a REAL contract-issued tick — transferable, visible in
// the explorer, and tradeable on XChain's native orderbook DEX.
//
// Why an AMM as a contract? XChain has a native orderbook DEX (ORDER/SWAP), but
// orderbooks have thin long-tail liquidity. An AMM is the textbook complement —
// and shipping it as a plain contract proves the VM's custody model is real and
// general-purpose.
//
// KEY INVARIANT — k (reserveA * reserveB) is non-decreasing across swaps. This
// holds because the FULL input, including the 0.3% fee, is added to reserves while
// the price credits the trader for only 99.7% of it. xchain.math is 64-significant-
// digit bignumber (it rounds at that precision — NOT Solidity-style integer floor),
// so per-op rounding is negligible beside the fee; the fee is what guarantees the
// pool grows. This is the property to fuzz.
//
// CUSTODY MODEL (and its footgun)
//
// XChain has no msg.value. Move tokens in via DEPOSIT, act via EXECUTE, atomically
// with BATCH — e.g. a swap:
//
//     BATCH( DEPOSIT(pool, tokenIn, amount), EXECUTE(pool, "swap", tokenIn, minOut) )
//
// Each entrypoint credits the caller by the balance delta since the last accounted
// reserve, so it MUST be atomic with the deposit. Tokens sent to the pool address
// outside a BATCHed call are credited to whoever calls next. Reserves are tracked
// in state (not raw balance), so direct donations don't move the price.
//
// LP TICK NAMING: the contract issues `lpTick` at deploy and becomes its owner.
// Pick an UNUSED name (ticks are a global namespace) — a collision makes the
// constructor's issue fail and the whole deploy revert (fail-fast, so two pools
// can never share an LP tick). Convention: "<TICKA><TICKB>LP".
// ---------------------------------------------------------------------------

var FEE_NUM = '997';   // 0.3% fee: keep 99.7% of the input in the pricing math
var FEE_DEN = '1000';

module.exports = {

    // initialize(tokenA, tokenB, lpTick) — create an empty pool and issue the LP tick.
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

        // LP supply grows with liquidity; cap it high. Contract becomes owner, so
        // it can mint on addLiquidity. A name collision reverts the deploy.
        var big = '99999999999999999999';
        xchain.emit.issue({ tick: lpTick, maxSupply: big, maxMint: big, decimals: '8', description: 'AMM LP share' });
    },

    // addLiquidity() — BATCH after DEPOSITing both tokenA and tokenB. Mints LP
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
        xchain.require(xchain.math.gt(shares, '0'), 'insufficient liquidity minted');

        xchain.state.set('reserveA', xchain.math.add(reserveA, depA));
        xchain.state.set('reserveB', xchain.math.add(reserveB, depB));
        xchain.state.set('totalShares', xchain.math.add(totalShares, shares));

        xchain.emit.mint({ tick: xchain.state.get('lpTick'), quantity: shares, destination: xchain.getSourceAddress() });
        return shares;
    },

    // removeLiquidity() — BATCH after DEPOSITing LP shares back to the pool.
    // Burns them and returns a proportional slice of both reserves.
    removeLiquidity: function (xchain) {
        var self = xchain.getContractAddress();
        var lpTick = xchain.state.get('lpTick');
        var reserveA = xchain.state.get('reserveA');
        var reserveB = xchain.state.get('reserveB');
        var totalShares = xchain.state.get('totalShares');

        var shares = xchain.getBalance(self, lpTick) || '0';
        xchain.require(xchain.math.gt(shares, '0'), 'must deposit LP shares');
        xchain.require(xchain.math.lte(shares, totalShares), 'shares exceed total');

        // Strictly proportional to the share of the pool being burned.
        var outA = xchain.math.divide(xchain.math.multiply(reserveA, shares), totalShares);
        var outB = xchain.math.divide(xchain.math.multiply(reserveB, shares), totalShares);
        xchain.require(xchain.math.gt(outA, '0') && xchain.math.gt(outB, '0'), 'insufficient liquidity burned');

        xchain.state.set('reserveA', xchain.math.subtract(reserveA, outA));
        xchain.state.set('reserveB', xchain.math.subtract(reserveB, outB));
        xchain.state.set('totalShares', xchain.math.subtract(totalShares, shares));

        // Burn the returned LP shares (the contract now custodies them).
        xchain.emit.destroy({ tick: lpTick, quantity: shares });

        var to = xchain.getSourceAddress();
        xchain.emit.send({ destination: to, tick: xchain.state.get('tokenA'), quantity: outA });
        xchain.emit.send({ destination: to, tick: xchain.state.get('tokenB'), quantity: outB });
        return JSON.stringify({ outA: outA, outB: outB });
    },

    // swap(tokenIn, minOut) — BATCH after DEPOSITing `tokenIn`. Trades for the other
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
        // (amountInWithFee), but the FULL input is later retained in reserves — that
        // 0.3% gap is the LP fee and is what makes k grow.
        var amountInWithFee = xchain.math.divide(xchain.math.multiply(amountIn, FEE_NUM), FEE_DEN);
        var amountOut = xchain.math.divide(
            xchain.math.multiply(reserveOut, amountInWithFee),
            xchain.math.add(reserveIn, amountInWithFee)
        );
        xchain.require(xchain.math.gt(amountOut, '0'), 'insufficient output');
        xchain.require(xchain.math.lt(amountOut, reserveOut), 'output exceeds reserves');
        xchain.require(xchain.math.gte(amountOut, minOut), 'slippage: output below minOut');

        // The FULL input (fee included) is retained in reserves, so k grows.
        var newIn  = xchain.math.add(reserveIn, amountIn);
        var newOut = xchain.math.subtract(reserveOut, amountOut);
        xchain.state.set(inIsA ? 'reserveA' : 'reserveB', newIn);
        xchain.state.set(inIsA ? 'reserveB' : 'reserveA', newOut);

        xchain.emit.send({ destination: xchain.getSourceAddress(), tick: tokenOut, quantity: amountOut });
        return amountOut;
    },

    // info() — read-only pool state for UIs / tests.
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
