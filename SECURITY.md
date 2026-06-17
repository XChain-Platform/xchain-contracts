# Security Policy

`xchain-contracts` is a CLI toolkit and template library for scaffolding, linting, and listing XChain smart-contract templates (escrow, vesting, crowdsale, AMM, and reusable patterns). It is a developer tool, not a deployed service. However, the fund-handling contract templates it ships are the reference implementations that developers build real contracts from. A correctness flaw in a template propagates to every contract forked from it, so we take reports seriously and respond fast.

If you've found a security issue, please **do not open a public issue or pull request**. Use the private channels below.

---

## How to report

### Preferred: GitHub Private Vulnerability Reporting

Open a draft advisory at:

<https://github.com/XChain-platform/xchain-contracts/security/advisories/new>

This is the fastest path. The advisory is private until we publish it.

### Alternative: Email

Email **security@dankest.llc** with:

- A description of the issue and the threat it poses.
- Reproduction steps or a proof-of-concept (a crafted template, input, or usage pattern that triggers the flaw).
- The affected version (see the version badge in `README.md`) and how you reproduced it.
- Any patches or mitigations you'd like considered.

For sensitive reports, encrypt the email body to our PGP key. The fingerprint will be published alongside the first signed release artifact; until then, the email channel is acceptable for first contact and we will coordinate an encrypted exchange before you share proof-of-concept details.

We do not currently offer a paid bug bounty. We do offer public credit in release notes and the advisory itself, unless you prefer to remain anonymous.

---

## Response timeline

| Stage | Target |
|---|---|
| Initial acknowledgement | within 72 hours |
| Triage + severity assignment | within 7 days |
| Fix or mitigation in master | within 30 days for high/critical, 90 days for lower severities |
| Coordinated public disclosure | up to 90 days from initial report, or sooner if a fix has shipped and operators are protected |

If we cannot meet a timeline, we will tell you why and propose a new one. We will not silently let a report age.

---

## Scope

### In scope

- Correctness of the fund-handling contract templates (escrow, vesting, crowdsale, amm): a flaw in how a template handles balances, fees, or payout splits propagates to every contract built from it.
- The scaffold, lint, and list CLI in `bin/xchain-contracts.js`.
- Any template logic that computes balances, fees, or payout splits incorrectly.
- The lint pipeline: a linter that passes an unsafe contract without warning is a security issue.

### Out of scope

- Behavior of a contract once deployed and executed on-chain (that lives in `xchain-vm` and `xchain-indexer`; report there).
- Modifications a user makes to a scaffolded template after forking it.
- Vulnerabilities in the underlying chains.
- Compromise of upstream npm dependencies (we mitigate via audit + review, but a backdoor in a dep is the dep author's incident, though we still want to hear about it).

If you are unsure, send the report anyway and we will tell you whether it falls in scope.

---

## What we ask

- Give us a reasonable window to fix before disclosing publicly. The 90-day ceiling is firm; earlier is fine once a fix has shipped.
- Test against `regtest` or a local stack where possible. Mainnet proofs-of-concept are accepted but should be the minimum needed.
- Do not run automated scanners against shared XChain infrastructure in a way that would impact availability for other operators.
- Do not access data, or attempt to access data, beyond what is needed to demonstrate the issue.

---

## What we will do

- Confirm receipt within the SLA above.
- Keep you informed as triage and remediation proceed.
- Credit you in the advisory and release notes, on request.
- Coordinate a CVE assignment when the severity warrants it.
- Publish a post-fix advisory describing the issue, the fix, and the affected version range.

---

## Versions covered

We ship security fixes against the latest release on `master`. Older releases are unsupported. The current version is recorded in the badge in `README.md` and in git tags.

---

Last reviewed: 2026-06-16.
