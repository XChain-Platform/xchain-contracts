# Maintainers

This file lists the people responsible for `xchain-contracts`, what each of them owns, and how to escalate issues that need a human's attention beyond what `CONTRIBUTING.md` and `SECURITY.md` cover.

The XChain Platform is in pre-launch development and ships under a single primary maintainer today. As contributors take on durable responsibility for areas of the codebase, they will be added here. This is a conventional MAINTAINERS file (an open-source norm used by distros and downstream packagers), not an aspirational org chart.

---

## Primary maintainer

| Role | Name | GitHub | Areas |
|---|---|---|---|
| Lead | J-Dog | [@J-Dog](https://github.com/J-Dog) | Everything: contract template library, scaffold/lint CLI, releases |

Contact:

- General and non-sensitive: open an issue at <https://github.com/XChain-platform/xchain-contracts/issues>.
- Code of Conduct: `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`).
- Security disclosures: GitHub Private Vulnerability Reporting, or `security@dankest.llc` (per `SECURITY.md`).

---

## Areas of responsibility

Until additional maintainers join, the lead owns every area below. The table is here so a future contributor (or downstream packager) can see what each area entails when scoping a contribution.

| Area | What it covers |
|---|---|
| Escrow template | `escrow/escrow.js`, its README walkthrough, and `escrow/escrow.test.js` |
| Vesting template | `vesting/vesting.js`, its README walkthrough, and `vesting/vesting.test.js` |
| Crowdsale template | `crowdsale/crowdsale.js`, its README walkthrough, and `crowdsale/crowdsale.test.js` |
| AMM template | `amm/amm.js`, its README walkthrough, and `amm/amm.test.js` |
| Reusable patterns | `patterns/` (access control, pausable, safe-transfer, input validation, state machines) and the pattern lint-gate test suite |
| Scaffold/lint/list CLI | `bin/xchain-contracts.js` and the CLI entry points for `scaffold`, `lint`, and `list` |
| Tests | Per-template test suites and `patterns/patterns.test.js` / `patterns/patterns.e2e.test.js` |
| Documentation | `README`, `SECURITY`, `CODE_OF_CONDUCT`, `CONTRIBUTING`, `MAINTAINERS`, and the per-template READMEs |

---

## Adding a maintainer

A contributor becomes a maintainer when they have:

1. Sustained contribution in a specific area for at least one release cycle (typically 2 to 3 weeks of active work).
2. Reviewed and merged at least three PRs from outside contributors.
3. Demonstrated awareness of the project's conventions: safe custody patterns (contracts read their own balance, never trust caller-supplied amounts), raw VM-compatible JavaScript with no banned globals, the `Keep a Changelog` format, and Node 22 as the pinned runtime for the lint and test pipeline.

Open a PR adding the new maintainer to the table above with their GitHub handle and area(s) of responsibility. The lead approves and merges.

## Removing a maintainer

A maintainer steps down by opening a PR removing their row. The lead also removes a maintainer who has been inactive for six months or who violates the Code of Conduct, after a written notice period.

---

## Escalation paths

If you cannot reach the relevant area maintainer within a reasonable window:

| Situation | Escalate to |
|---|---|
| Active security incident | `security@dankest.llc` (per `SECURITY.md`) |
| A flaw in a fund-handling template (escrow/vesting/crowdsale/amm) | Open a public issue tagged `security` AND email `security@dankest.llc` |
| Code-of-conduct concern | `conduct@dankest.llc` (per `CODE_OF_CONDUCT.md`) |
| PR has been open without review for 14+ days | Comment `@J-Dog` on the PR; if no response within 7 more days, open an issue tagged `governance` with the PR link |

---

## Decision-making

The lead makes final calls on:

- Template correctness and economics (custody patterns, fee math, edge-case safety).
- CLI behavior (scaffold output, lint rules, list format).
- Which patterns ship in the `patterns/` library.
- Release timing and version policy.
- Adopting a new heavy dependency.
- Code-of-conduct enforcement, and maintainer additions or removals.

Smaller calls (bug fixes, additions within an existing area, documentation, dependency bumps inside an existing minor) go through PR review by the area maintainer.

---

## Cross-project relationships

| Project | Relationship |
|---|---|
| [`xchain-vm`](https://github.com/XChain-platform/xchain-vm) | Executes contracts deployed from these templates; the lint CLI delegates to the VM's linter |
| [`xchain-indexer`](https://github.com/XChain-platform/xchain-indexer) | Processes the contract actions (`DEPOSIT`, `EXECUTE`, `BATCH`) that templates emit |
| [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) | Protocol spec: the contract gateway, custody model, and ACTION definitions these templates build on |

The contracts maintainer is not automatically a maintainer of those sibling projects. Cross-project changes go through each project's own review process.
