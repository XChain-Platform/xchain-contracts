# AMM (constant-product)

A two-token automated market maker. It holds a pool of `tokenA` and `tokenB` and
prices swaps by the constant-product rule (`reserveA * reserveB = k`). Liquidity
providers deposit both tokens and receive **LP-share tokens**; swappers trade one
token for the other, paying a **0.3% fee** that accrues to the pool — and thus to
LP holders.

This is the flagship template. It demonstrates the whole platform at once:
contract custody, contract-issued tokens, and a real DeFi primitive. The LP shares
are a genuine contract-issued tick — transferable, visible in the explorer, and
**tradeable on XChain's native orderbook DEX**. An AMM is the textbook complement
to an orderbook (which has thin long-tail liquidity), shipped as a plain contract.

## The invariant (what makes it safe)

`k` is **non-decreasing across swaps**. The full input — including the 0.3% fee —
is added to reserves, while the price credits the trader for only 99.7% of it. That
0.3% gap stays in the pool and grows `k`, raising every LP share's redemption value.

`xchain.math` is 64-significant-digit bignumber and rounds at that precision (it is
**not** Solidity-style integer-floor); per-operation rounding is negligible beside
the fee. The k-invariant is the property the test suite fuzzes.

## Custody model (and its footgun)

No `msg.value`. Move tokens in via DEPOSIT, act via EXECUTE, atomically with BATCH:

```
# swap 100 AAA for BBB, accepting no less than 90 out
BATCH( DEPOSIT(pool, AAA, 100), EXECUTE(pool, "swap", "AAA", "90") )

# add liquidity
BATCH( DEPOSIT(pool, AAA, 1000), DEPOSIT(pool, BBB, 1000), EXECUTE(pool, "addLiquidity") )
```

Every entrypoint credits the caller by the balance delta since the last accounted
reserve, so it MUST be atomic with the deposit. Reserves are tracked in **state**,
not raw balance, so a direct token donation can't move the price.

## Methods

| Method | BATCH with | Effect |
|---|---|---|
| `initialize(tokenA, tokenB, lpTick)` | — (deploy) | Empty pool; issues `lpTick` (contract-owned). |
| `addLiquidity()` | DEPOSIT A + DEPOSIT B | Mints LP shares (`sqrt(a*b)` first, else proportional to the scarcer side). |
| `removeLiquidity()` | DEPOSIT LP shares | Burns them; returns a proportional slice of both reserves. |
| `swap(tokenIn, minOut)` | DEPOSIT tokenIn | Trades at the constant-product price minus 0.3%; reverts below `minOut`. |
| `info()` | — | `{ tokenA, tokenB, lpTick, reserveA, reserveB, totalShares }`. |

## LP tick naming

The contract issues `lpTick` at deploy and becomes its owner. **Pick an unused
name** — ticks are a global namespace, and a collision makes the constructor's
issue (and the whole deploy) revert. That fail-fast guarantees two pools can never
share an LP tick. Convention: `"<TICKA><TICKB>LP"`.

## Attacks we considered

- **k erosion / free value.** The fee makes k strictly grow; the suite fuzzes a
  long mixed swap sequence and asserts k never decreases.
- **Slippage / sandwiching.** `swap` reverts if the output is below the caller's
  `minOut`. Always set it.
- **Pool drain.** The price formula yields `amountOut < reserveOut` for any finite
  input, and the contract asserts it — the output reserve can never reach zero.
- **Donation price manipulation.** Reserves are accounted in state, not read from
  raw balance, so tokens sent directly to the pool don't shift the price (they just
  become claimable as part of the next accounted deposit — so, as everywhere here,
  only ever move tokens inside a BATCHed call).
- **Share dilution via skewed deposits.** `addLiquidity` mints on the scarcer side,
  so an unbalanced deposit can't mint extra shares; the surplus enriches the pool.
- **Double / unauthorized settlement.** Each path keys off the caller and the
  balance delta within one atomic execution; emissions and state commit together.

## Known limitations (teaching baseline)

- **Deposit in ratio.** Off-ratio `addLiquidity` donates the surplus side to the
  pool (standard Uniswap-v2 behavior). Match the current reserve ratio.
- **No flash-swap / no protocol fee / no TWAP oracle.** Kept out for clarity; add
  them on a fork if needed.
- **Exact, paired tokens only.** Like the other templates: move only the configured
  ticks, only inside a BATCHed call.

## Tests

```
cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/amm/amm.test.js
```

LP delivery is asserted via the emitted MINT action (the E2E mock indexer doesn't
credit mint `destination`); swap/withdraw token movements are asserted via balances
and reserve-consistency, and k via exact bignumber comparison.

## License

MIT — fork it, ship it, change it.
