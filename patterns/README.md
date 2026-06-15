# Contract Pattern Library

Small, audited, **copy-paste** building blocks for XChain contracts — the
idioms the [templates](../README.md) use, factored out so you can drop them into
your own contract.

XChain contracts are a single self-contained JavaScript blob with **no imports
and no npm at runtime**, so these aren't a package you depend on — they're
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

Paste only the helpers you actually call — every byte counts against the 64 KB
code ceiling.

## The patterns

| File | Helpers | Use it for |
|---|---|---|
| [access-control.js](./access-control.js) | `onlyOwner` · `isOwner` · `onlyRole` | gate methods to the owner or a named role |
| [pausable.js](./pausable.js) | `whenNotPaused` · `isPaused` · `setPaused` | an owner-controlled circuit breaker |
| [safe-transfer.js](./safe-transfer.js) | `heldBalance` · `requireHeld` · `depositedSince` | size transfers from real holdings, never caller input |
| [validation.js](./validation.js) | `requireAddress` · `requirePositive` · `requireEnum` · `requireIntInRange` | validate method inputs up front |
| [state-machine.js](./state-machine.js) | `requireStatus` · `requireStatusIn` · `setStatus` | an explicit `status` lifecycle with guarded transitions |

Every helper here passes `xchain-lint` clean (no banned APIs, no float math, ES2020).
Run the linter on your finished contract before deploying:

```bash
node ../xchain-vm/bin/lint.js my-contract.js
```

## You do NOT need a reentrancy guard

If you're coming from Solidity, you'll reach for a `nonReentrant` modifier.
**XChain doesn't need one — reentrancy is impossible by construction.**

- Token emissions (`emit.send`, `emit.mint`, …) are **deferred**: they're queued
  during your method and applied **after** it returns. A contract cannot observe
  the effect of its own emission mid-execution, and `getBalance()` reflects state
  as of the start of execution.
- Cross-contract calls (`emit.execute`) are also **deferred, not inline**: the
  callee runs after your method finishes, in the order you emitted, within the
  same atomic scope — it sees your already-committed state and there is no return
  value. There is no synchronous re-entry to exploit.

The discipline that replaces a reentrancy guard is simply **commit state before
emitting** — set your terminal status / delete the per-caller record first, then
emit. The `state-machine` and `safe-transfer` patterns encode exactly that
ordering. If any emitted action later fails validation, the whole execution
(state changes *and* emissions) is rolled back atomically.

## License

[MIT](../LICENSE) — fork freely, including into closed-source contracts.
