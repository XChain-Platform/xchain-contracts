# Lane report: cx-xc-5957

## Files touched (this round)
- treasury/README.md: resolved the merge conflict with develop, keeping this row's "Queue spam" entry (bounded: 16 of 64 live slots per holder, abandoned unarmed proposals release their slot). The state-key limitation entry stays removed.
- treasury/treasury_test/invariants.js: restored the rec.paid versus SENT conservation assertion that the previous round dropped.

## Merge of develop
Merged origin/develop (984a6fc) into the base with message "sync trunk". Only treasury/README.md conflicted. The merge commit necessarily carries develop's changes to paths outside Surfaces (cardDispenser, crowdsale, dutchAuction, counterpartyBridge, etc.); those come from develop itself and were not edited by this lane. If the surface check rejects merge-inherited paths, that is a conflict between the merge instruction and the Surfaces rule and needs an orchestrator decision.

## Conservation assertion
Settled proposals now roll out of a 16-entry archive, so the total cannot always be rebuilt from state. The check now: for every proposal that produced a SENT, the retrievable record must be EXECUTED and its paid must equal the SENT settled amount; no EXECUTED record may lack a SENT; the recorded total must equal SENT exactly when all paid proposals are still retrievable, and never exceed it otherwise.

## Tests
- Could not run the contract suites: the xchain-vm sibling checkout (/home/user/xchain-vm) is absent in this venue, so the harness did not load. `mocha` on preflight, treasury, README lint and badge tests: 11 passing, 76 pending, 7 failing, the failures being the preflight harness-load guard. Nothing about contract behavior was proven.
- `node --check` passes on treasury/treasury.js and treasury/treasury_test/invariants.js.
- The new invariant logic and the growth tests are therefore unverified here and need a run on the Linux venue with xchain-vm under Node 22.

RUN-COMPLETE e464d9a12c2e39ea46c09cec5c195db9
