# XChain Contract Template Library

Audited, copy-pasteable starting points for XChain smart contracts — worked
examples of the "contracts-as-orchestration" model. Each template is a real
contract you can fork, with a walkthrough and an explicit *"attacks we
considered"* section.

These templates do **not** reimplement native actions. XChain already has native
`ORDER`/`SWAP` (orderbook DEX), `DISPENSER`, `DIVIDEND`, and `ISSUE` — use those
directly. Templates exist for what native actions can't do: custody with custom
release rules, multi-step state machines, and the cross-chain / oracle /
attestation primitives.

## License

**MIT** — fork freely, including into closed-source products. (The XChain
*platform* is AGPL-3.0; the *templates* are intentionally permissive.)

## The custody model

There is no `msg.value`. Tokens enter a contract via a separate `DEPOSIT` to the
contract's address; logic runs via `EXECUTE`; the two are made atomic with
`BATCH(DEPOSIT, EXECUTE)`. A contract reads what it holds with
`xchain.getBalance(xchain.getContractAddress(), tick)` and never trusts a
caller-supplied amount. See `escrow/` for the fully-worked explanation.

## Roster

| Template | Status | Teaches |
|---|---|---|
| [escrow](./escrow/) | ✅ 12/12 VM-green | Custody baseline: DEPOSIT, balance-verified funding, conditional release/refund, access control, deadline reclaim. |
| [vesting](./vesting/) | ✅ 14/14 VM-green | Linear release with cliff, partial-claim accounting, optional revocation. |
| [crowdsale](./crowdsale/) | ✅ 12/12 VM-green | Capped raise, soft cap, deadline, refunds; contract-issued sale token (emit.issue + mint). |
| [amm](./amm/) | ✅ 11/11 VM-green | Constant-product AMM; LP positions as real, tradeable ticks; 0.3% fee + slippage guard; k-invariant fuzzed. |

Showcase tier (after the core): cross-chain orchestration, oracle-conditional
payout, attestation-driven.

## Prerequisite

Value-holding templates require the VM gateway's `getBalance` / `getTokenInfo` to
return real data (indexer wiring) — landed alongside this library. Without it a
contract cannot read its own holdings.
