# Contract Pattern Library

Small, audited, **copy-paste** building blocks for XChain contracts - the
idioms the [templates](../README.md) use, factored out so you can drop them into
your own contract.

XChain contracts are a single self-contained JavaScript blob with **no imports
and no npm at runtime**, so these aren't a package you depend on - they're
vetted source you paste in. Each file is a set of top-level helper functions
that take `xchain` as their first argument (the same shape as the templates'
own `settle` / `vestedAmount` helpers).

## How to use

Paste the helpers you need **above** your `module.exports` (top-level function
declarations are hoisted, so your methods can call them), then call them inside
your methods:

```javascript
// --- pasted from access-control.js + state-machine.js ---
function onlyOwner(xchain) {
    xchain.require(xchain.getSourceAddress() === xchain.state.get('owner'), 'caller is not the owner');
}
function requireStatus(xchain, expected) {
    var current = xchain.state.get('status');
    xchain.require(current === expected, 'invalid state: expected ' + expected + ', got ' + current);
}
function setStatus(xchain, next) { xchain.state.set('status', next); }

module.exports = {
    initialize: function (xchain) {
        xchain.state.set('owner', xchain.getInputParam(0));
        xchain.state.set('status', 'OPEN');
    },
    close: function (xchain) {
        onlyOwner(xchain);
        requireStatus(xchain, 'OPEN');
        setStatus(xchain, 'CLOSED');
    }
};
```

Paste only the helpers you actually call - every byte counts against the 64 KB
code ceiling.

## The patterns

| File | Helpers | Use it for |
|---|---|---|
| [access-control.js](./access-control.js) | `onlyOwner` · `isOwner` · `onlyRole` | gate methods to the owner or a named role |
| [pausable.js](./pausable.js) | `whenNotPaused` · `isPaused` · `setPaused` | an owner-controlled circuit breaker |
| [safe-transfer.js](./safe-transfer.js) | `heldBalance` · `requireHeld` · `depositedSince` | size transfers from real holdings, never caller input |
| [validation.js](./validation.js) | `requireAddress` · `requirePositive` · `requirePlainDecimal` · `requireEnum` · `requireIntInRange` | validate method inputs up front |
| [state-machine.js](./state-machine.js) | `requireStatus` · `requireStatusIn` · `setStatus` | an explicit `status` lifecycle with guarded transitions |

Every helper here passes `xchain-lint` clean (no banned APIs, no float math, ES2020).
Run the linter on your finished contract before deploying:

```bash
node ../xchain-vm/bin/lint.js my-contract.js
```

## Coming from OpenZeppelin

If you know OpenZeppelin, find the building block by the name you already use.
These are **OZ-equivalents**, not the OZ contracts: XChain contracts are a single
import-free JS blob, so you paste the helper, you do not depend on a package. For
several OZ contracts the answer is "you don't need it" - a native protocol action
or the deferred-emission model already covers it. A machine-readable version of
this table lives in [oz-aliases.json](./oz-aliases.json) (consumed by the docs
and the Solidity-to-XChain on-ramp tooling).

| OpenZeppelin | XChain equivalent | Where |
|---|---|---|
| `Ownable` | `onlyOwner` / `isOwner` | [access-control.js](./access-control.js) |
| `AccessControl` | `onlyRole` | [access-control.js](./access-control.js) |
| `Pausable` | `whenNotPaused` / `isPaused` / `setPaused` (or token-wide `SLEEP`) | [pausable.js](./pausable.js) |
| `SafeERC20` | `heldBalance` / `requireHeld` / `depositedSince` | [safe-transfer.js](./safe-transfer.js) |
| `Address` | `requireAddress` | [validation.js](./validation.js) |
| `ReentrancyGuard` | **not needed** - deferred emissions (see below) | - |
| `SafeMath` | **not needed** - built-in `xchain.math.*` bignumber, floats rejected at deploy | - |
| `ERC20` | **not a contract** - native `ISSUE` + `SEND` | protocol action |
| `ERC721` | **not a contract** - `ISSUE` with `DECIMALS=0`, `LOCK_MAX_SUPPLY=1` | protocol action |
| `ERC2981` (royalties) | **controller-bound token** - `ISSUE` v6 binds a guard | protocol action |

For the full concept map (`msg.sender`, `msg.value`, `mapping`, `modifier`, and
worked side-by-side examples), see **Solidity to XChain** in
`xchain-documentation/developer-guide/Solidity_To_XChain.md`.

## You do NOT need a reentrancy guard

If you're coming from Solidity, you'll reach for a `nonReentrant` modifier.
**XChain doesn't need one - reentrancy is impossible by construction.**

- Token emissions (`emit.send`, `emit.mint`, …) are **deferred**: they're queued
  during your method and applied **after** it returns. A contract cannot observe
  the effect of its own emission mid-execution, and `getBalance()` reflects state
  as of the start of execution.
- Cross-contract calls (`emit.execute`) are also **deferred, not inline**: the
  callee runs after your method finishes, in the order you emitted, within the
  same atomic scope - it sees your already-committed state and there is no return
  value. There is no synchronous re-entry to exploit.

The discipline that replaces a reentrancy guard is simply **commit state before
emitting** - set your terminal status / delete the per-caller record first, then
emit. The `state-machine` and `safe-transfer` patterns encode exactly that
ordering. If any emitted action later fails validation, the whole execution
(state changes *and* emissions) is rolled back atomically.

## Writing a controller `guard`: bulk distributions are sender-side only

If your contract is a token controller (bound via `ISSUE` v6, see
`xchain-documentation/protocol/Controller_Bound_Tokens.md`), remember that bulk
distribution actions (`AIRDROP`, `DIVIDEND`, `SWEEP` balance moves) invoke your
`guard` **once per controlled tick, on the sender's aggregate outbound move**:
`from` is the distributor, `to` is empty, `amount` is the total leaving the
sender. There is **no per-recipient invocation**; that is a deliberate protocol
property (bounded VM work, no recipient-side griefing of a whole drop).

Do not write per-recipient allowlist logic into the bulk branch of a guard; it
will never see individual recipients. Receive-side policy belongs in **transfer
restrictions** instead: enforce holder eligibility in the `transfer` guard on the
token's subsequent `SEND`s and listings (an unapproved holder's dropped balance
is inert), or deny the aggregate to force individually guarded `SEND`s. Accounts
that want to refuse unsolicited direct sends use an inbound `ADDRESS` `transfer`
binding, which likewise does not gate bulk drops.

## License

[MIT](../LICENSE), fork freely, including into closed-source contracts.
