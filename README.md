# XChain Contract Template Library

Audited, copy-pasteable smart-contract templates for the [XChain
Platform](https://xchain.io): worked examples of the **contracts-as-orchestration**
model. Each template is a real contract you can fork, paired with a walkthrough and
an explicit *"attacks we considered"* section, and verified by running the actual
template through the XChain VM.

The goal is to seed the mental model: an XChain contract is a deterministic
JavaScript program that custodies tokens and emits protocol actions. These
templates show how to do that **safely**.

## Quick start

**scaffold → customize → lint → deploy.**

```bash
# 1. Scaffold a template (or print available names with `list`)
npx xchain-contracts list
npx xchain-contracts scaffold escrow my-escrow.js

# 2. ...edit my-escrow.js...

# 3. Lint it against the exact deploy-time rules (needs Node 22 / isolated-vm)
npx xchain-contracts lint my-escrow.js

# 4. Deploy via the SDK (which lints again before spending a transaction)
#    sdk.deploy({ CODE: fs.readFileSync('my-escrow.js','utf8'), GAS_LIMIT: '200000' }, encoder)
```

Prefer to stay in JS? The SDK exposes the same library: `sdk.scaffold('escrow')`
returns the source, `sdk.validateContract(source)` runs the advisory linter (no
Node-22 requirement), and `sdk.deploy(..., { lint })` blocks a guaranteed-to-fail
deploy. See the [developer guide](https://docs.xchain.io).

Reusable building blocks (access control, pausable, safe-transfer, input
validation, state machines) live in [`patterns/`](./patterns/README.md); paste
the helpers you need into your contract.

### No code at all: the policy generator

Most people who reach for a contract actually want a *token with rules*
(royalties, transfer restrictions, a pause switch) and never want to write
contract code. Describe the policy in a small JSON file and generate a
deploy-ready **controller guard** contract, no code written:

```bash
# describe the policy (see lib/policy.example.json), then:
npx xchain-contracts policy my-policy.json my-guard.js
# → writes my-guard.js and prints the ISSUE v6 bind steps
```

The config supports `pausable`, `freeze` (denylist), `allowlist`, a `royalty`
proceeds split, a `maxTakeBps` cap, and a `permissions` manifest, over any of the
`transfer`/`trade`/`burn`/`mint`/`stake`/`all` action classes. A controller guard
is a contract the indexer runs *before* a gated native action settles; a token
binds to it with ISSUE v6 (SDK: `sdk.controller.bindToken`). The generated source
is built to pass the deploy linter clean. See
[`lib/policy-gen.js`](./lib/policy-gen.js).

## The templates

| Template | Contract | Guide | Tests | What it teaches |
|---|---|---|---|---|
| **Escrow** | [escrow.js](./escrow/escrow.js) | [README](./escrow/README.md) | [tests](./escrow/escrow.test.js) | The custody baseline: DEPOSIT funding verified on-chain, conditional release/refund, an arbiter, and a deadline so funds can't be locked forever. |
| **Vesting** | [vesting.js](./vesting/vesting.js) | [README](./vesting/README.md) | [tests](./vesting/vesting.test.js) | Linear release with a cliff, partial-claim accounting, and optional revocation. |
| **Crowdsale** | [crowdsale.js](./crowdsale/crowdsale.js) | [README](./crowdsale/README.md) | [tests](./crowdsale/crowdsale.test.js) | A capped raise with a soft cap, deadline, and refunds, plus a **contract that issues its own token** and mints it to buyers. |
| **AMM** | [amm.js](./amm/amm.js) | [README](./amm/README.md) | [tests](./amm/amm.test.js) | A constant-product market maker. LP positions are **real, tradeable ticks**; 0.3% fee; slippage protection; the `k`-invariant is fuzz-tested. |
| **Treasury** | [treasury.js](./treasury/treasury.js) | [README](./treasury/README.md) | [tests](./treasury/treasury.test.js) | A poll-governed treasury hardened against low-turnout governance raids: binding `VOTE` polls, a timelock between "passed" and "paid", and a guardian veto. |
| **Card dispenser** | [cardDispenser.js](./cardDispenser/cardDispenser.js) | [README](./cardDispenser/README.md) | [tests](./cardDispenser/cardDispenser.test.js) | A random card-pack dispenser backed by the contract's own token inventory (no mint): stock-weighted rarity, deterministic on-chain randomness and its limits. |
| **Price bet** | [priceBet.js](./priceBet/priceBet.js) | [README](./priceBet/README.md) | [tests](./priceBet/priceBet.test.js) | A two-party binary option settled by the PRICE oracle at an agreed round: round-anchored determinism, permissionless settlement, liveness escape hatches. |
| **Price bet (timed)** | [priceBetTimed.js](./priceBetTimed/priceBetTimed.js) | [README](./priceBetTimed/README.md) | [tests](./priceBetTimed/priceBetTimed.test.js) | The timestamp variant: the first oracle round at/after a settle time decides, with a gas-capped, cursor-persisted round scan. |
| **Stable vault** | [stableVault.js](./stableVault/stableVault.js) | [README](./stableVault/README.md) | [tests](./stableVault/stableVault.test.js) | A mini-MakerDAO: over-collateralized vaults that mint the contract's own stable token, oracle staleness gating, and permissionless liquidation. |
| **URL oracle** | [urlOracle.js](./urlOracle/urlOracle.js) | [README](./urlOracle/README.md) | [tests](./urlOracle/urlOracle.test.js) | Reading off-chain HTTP data without breaking determinism: the ATTEST request/callback round-trip. |

Start with **escrow**: it explains the custody model the others build on.

## What these are (and are not)

These templates do **not** reimplement native protocol actions. XChain already has
native `ORDER`/`SWAP` (an orderbook DEX), `DISPENSER`, `DIVIDEND`, and `ISSUE`; use
those directly. Templates exist for what native actions *can't* do: custody with
custom release rules, multi-step state machines, and (in the showcase tier) the
cross-chain, oracle, and attestation primitives.

The AMM is the clearest example of the distinction: there is no native AMM (only an
orderbook, which has thin long-tail liquidity), so an AMM-as-a-contract is both
genuinely useful and the best proof that the VM's custody model is real.

## The custody model (read before forking)

XChain has **no `msg.value`**, so a contract call carries no tokens. Instead:

- A contract is an address (`C:<CHAIN>:<index>`) that holds balances like a wallet.
- Tokens enter via a separate **`DEPOSIT`** action to that address.
- Logic runs via an **`EXECUTE`** action.
- To fund-and-act atomically, submit both in one **`BATCH`**:

  ```
  BATCH( DEPOSIT(contract, TICK, amount), EXECUTE(contract, "method", ...args) )
  ```

A safe contract **never trusts a caller-supplied amount**: it reads its own balance
with `xchain.getBalance(xchain.getContractAddress(), tick)`. Every template here
follows that rule; [escrow's README](./escrow/README.md) explains it in full.

## Linting

`xchain-contracts lint` runs each contract through the VM's **exact** deploy-time
validation (V8 syntax, the acorn metering pass, reserved identifiers, banned
`Math.*`, banned `BigInt`/`RegExp` literals) plus the logic-level advisories
(crossCallable integrity, unbounded loops, unchecked `state.get`, …). A clean
result means the contract clears deployment. It delegates to `xchain-vm`'s linter,
so it needs **Node 22** / `isolated-vm`.

```bash
npm run lint                                  # lint every template + pattern
npx xchain-contracts lint my-escrow.js        # lint one file
npx xchain-contracts lint my-escrow.js --json # machine-readable
# exit 0 = clean · 1 = errors · warnings print to stderr
```

This is the CI gate for the library. Authors who want the advisory rules without a
Node-22 install can run `sdk.validateContract(source)` from the SDK (everything
except the V8 step).

## Running the tests

Each template's tests load the real contract and run it through the XChain VM
(`xchain-vm`, which requires **Node 22** / `isolated-vm`), checked out alongside
this repo:

```bash
npm test                          # all templates + the pattern lint-gate
npx mocha --timeout 0 patterns/patterns.test.js   # pattern lint-gate only (runs on any Node)
```

## Prerequisite

Value-holding contracts require the VM gateway's `getBalance` / `getTokenInfo` to
return real data, wired in `xchain-indexer`. Without it a contract cannot read its
own holdings to verify deposits.

## License

[MIT](./LICENSE), fork freely, including into closed-source products. (The XChain
*platform* is licensed AGPL-3.0; these *templates* are intentionally permissive so
you can build proprietary contracts on top of them.)
