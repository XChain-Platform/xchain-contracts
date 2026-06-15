# XChain Contract Template Library

Audited, copy-pasteable smart-contract templates for the [XChain
Platform](https://xchain.io) — worked examples of the **contracts-as-orchestration**
model. Each template is a real contract you can fork, paired with a walkthrough and
an explicit *"attacks we considered"* section, and verified by running the actual
template through the XChain VM.

The goal is to seed the mental model: an XChain contract is a deterministic
JavaScript program that custodies tokens and emits protocol actions. These
templates show how to do that **safely**.

## The templates

| Template | Contract | Guide | Tests | What it teaches |
|---|---|---|---|---|
| **Escrow** | [escrow.js](./escrow/escrow.js) | [README](./escrow/README.md) | [tests](./escrow/escrow.test.js) | The custody baseline — DEPOSIT funding verified on-chain, conditional release/refund, an arbiter, and a deadline so funds can't be locked forever. |
| **Vesting** | [vesting.js](./vesting/vesting.js) | [README](./vesting/README.md) | [tests](./vesting/vesting.test.js) | Linear release with a cliff, partial-claim accounting, and optional revocation. |
| **Crowdsale** | [crowdsale.js](./crowdsale/crowdsale.js) | [README](./crowdsale/README.md) | [tests](./crowdsale/crowdsale.test.js) | A capped raise with a soft cap, deadline, and refunds — and a **contract that issues its own token** and mints it to buyers. |
| **AMM** | [amm.js](./amm/amm.js) | [README](./amm/README.md) | [tests](./amm/amm.test.js) | A constant-product market maker. LP positions are **real, tradeable ticks**; 0.3% fee; slippage protection; the `k`-invariant is fuzz-tested. |

Start with **escrow** — it explains the custody model the others build on.

## What these are (and are not)

These templates do **not** reimplement native protocol actions. XChain already has
native `ORDER`/`SWAP` (an orderbook DEX), `DISPENSER`, `DIVIDEND`, and `ISSUE` — use
those directly. Templates exist for what native actions *can't* do: custody with
custom release rules, multi-step state machines, and (in the showcase tier) the
cross-chain, oracle, and attestation primitives.

The AMM is the clearest example of the distinction: there is no native AMM (only an
orderbook, which has thin long-tail liquidity), so an AMM-as-a-contract is both
genuinely useful and the best proof that the VM's custody model is real.

## The custody model (read before forking)

XChain has **no `msg.value`** — a contract call carries no tokens. Instead:

- A contract is an address (`C:<CHAIN>:<index>`) that holds balances like a wallet.
- Tokens enter via a separate **`DEPOSIT`** action to that address.
- Logic runs via an **`EXECUTE`** action.
- To fund-and-act atomically, submit both in one **`BATCH`**:

  ```
  BATCH( DEPOSIT(contract, TICK, amount), EXECUTE(contract, "method", ...args) )
  ```

A safe contract **never trusts a caller-supplied amount** — it reads its own balance
with `xchain.getBalance(xchain.getContractAddress(), tick)`. Every template here
follows that rule; [escrow's README](./escrow/README.md) explains it in full.

## Running the tests

Each template's tests load the real contract and run it through the XChain VM
(`xchain-vm`, which requires **Node 22** / `isolated-vm`). With the `xchain-vm`
repository checked out alongside this one:

```bash
cd xchain-vm
npx mocha --timeout 0 ../xchain-contracts/escrow/escrow.test.js
npx mocha --timeout 0 ../xchain-contracts/vesting/vesting.test.js
npx mocha --timeout 0 ../xchain-contracts/crowdsale/crowdsale.test.js
npx mocha --timeout 0 ../xchain-contracts/amm/amm.test.js
```

## Linting the templates

Before (or instead of) a full test run, you can check a contract against the VM's
deploy-time validation rules — V8 syntax, the acorn metering pass, reserved
identifiers, banned `Math.*`, and banned `BigInt`/`RegExp` literals. This is the
exact gate the indexer applies at DEPLOY, so a clean result means the contract will
clear deployment. With `xchain-vm` checked out alongside this repo:

```bash
node ../xchain-vm/bin/lint.js ./*/*.js          # lint all four templates
node ../xchain-vm/bin/lint.js ./escrow/escrow.js --json
# exit 0 = clean · 1 = errors · warnings print to stderr
```

This doubles as the CI gate for the template library. (Authors building their own
contracts can run the same rules from the SDK with `sdk.validateContract(source)` —
advisory, no Node-22/`isolated-vm` requirement — see the developer guide.)

## Prerequisite

Value-holding contracts require the VM gateway's `getBalance` / `getTokenInfo` to
return real data — wired in `xchain-indexer`. Without it a contract cannot read its
own holdings to verify deposits.

## License

[MIT](./LICENSE) — fork freely, including into closed-source products. (The XChain
*platform* is licensed AGPL-3.0; these *templates* are intentionally permissive so
you can build proprietary contracts on top of them.)
