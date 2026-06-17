# Contributing to XChain Contracts

Thanks for considering a contribution. `xchain-contracts` is the reference template library that developers fork to build real, value-holding contracts. Correctness here matters downstream, so we trade speed for care on every commit.

If you're reporting a security issue, **stop here** and read [`SECURITY.md`](./SECURITY.md) instead. Security reports go through a private channel.

---

## Quick links

- Project overview: [`README.md`](./README.md)
- Full component docs: the [`xchain-documentation`](https://github.com/XChain-platform/xchain-documentation) repository (architecture, contract patterns, protocol spec)
- Disclosure policy: [`SECURITY.md`](./SECURITY.md)
- Code of Conduct: [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md)
- License: [`LICENSE`](./LICENSE) (MIT, intentionally permissive so you can build proprietary contracts on top)

---

## Repo layout in 30 seconds

```
xchain-contracts/
├── bin/                  CLI entry point: xchain-contracts.js (scaffold, lint, list)
├── escrow/               escrow template, guide, and tests
├── vesting/              vesting template, guide, and tests
├── crowdsale/            crowdsale template, guide, and tests
├── amm/                  AMM template, guide, and tests
├── patterns/             reusable building blocks (access control, safe-transfer, ...)
├── SECURITY.md           private vulnerability disclosure
└── package.json          scripts + dependencies
```

---

## Setting up

### Prerequisites

- **Node.js 22 exactly.** The platform pins Node 22 fleet-wide: the `xchain-vm` dependency (which the lint step and all template tests require) uses `isolated-vm`, whose native binding is V8-ABI-specific. Node 18 fails with `ERR_REQUIRE_ESM`; newer majors are not validated. Use 22.
- **`xchain-vm` checked out alongside this repo** (the dependency is declared as `file:../xchain-vm`). Clone it as a sibling directory before running tests.

### First-time install

```bash
git clone https://github.com/XChain-platform/xchain-contracts.git
cd xchain-contracts
npm install
```

No database, no API server, no coin node needed.

---

## Running it

```bash
npm run list      # list available template names
npm run scaffold  # scaffold a template (pass name and output path as arguments)
npm run lint      # lint every template + pattern against VM deploy-time rules
```

You can also invoke the CLI directly:

```bash
node bin/xchain-contracts.js list
node bin/xchain-contracts.js scaffold escrow my-escrow.js
node bin/xchain-contracts.js lint my-escrow.js
```

---

## Tests

Each template's tests load the real contract and run it through `xchain-vm`. All suites run with a single command:

| Tier | Command | Needs external services |
|---|---|---|
| Full suite | `npm test` | No (but needs `xchain-vm` sibling + Node 22) |
| Pattern lint-gate only | `npx mocha --timeout 0 patterns/patterns.test.js` | No |

Run `npm test` before every commit. New template logic or pattern helpers should come with test coverage in the matching `*.test.js` file. The lint pipeline (`npm run lint`) is the CI gate for the library; confirm it exits 0 before opening a PR.

---

## Coding style

- **Plain JavaScript**, no TypeScript.
- **No linter is configured.** Match the style of the surrounding file: naming, structure, and comment density.
- **Comments are rare on purpose.** Don't restate what well-named code already says. Do comment a *why* that isn't obvious: a hidden invariant, a security property, a constraint with a reference.
- **Never use the em-dash character** in code, comments, or docs. Rewrite the sentence (a comma, colon, or parentheses) instead.
- **Two trailing spaces** on consecutive bold-label markdown lines so CommonMark renders the line break instead of collapsing them.
- **Correctness over cleverness.** Templates are reference implementations. Prefer explicit, readable code over concise tricks. Annotate security-critical invariants (for example: never trust a caller-supplied amount; always read balance from `xchain.getBalance`).

---

## Commit messages

Match the existing log style: a concise subject line, then a short body explaining what changed and why.

- Branch off `master` and keep history linear (rebase, don't merge).
- One logical change per commit; don't batch unrelated work.
- **No `Co-Authored-By` trailers.** This is a project policy.
- **Never `--no-verify`.** If a hook fails, fix the cause; don't bypass it.

---

## Pull requests

CI is the full `npm test` + `npm run lint` gate. Before opening a PR:

1. Run `npm test` and `npm run lint` and confirm both pass.
2. Make sure `git status` is clean apart from intended changes (no `node_modules/`, no editor leftovers).
3. Open the PR with a clear title and a description of what changed and why.

For non-security bugs, open an issue at <https://github.com/XChain-platform/xchain-contracts/issues/new>. For security bugs, see [`SECURITY.md`](./SECURITY.md).

---

## Code of Conduct

We follow our [Code of Conduct](./CODE_OF_CONDUCT.md), adapted from the Contributor Covenant 2.1. Be kind, assume good faith, and disagree without being a jerk.

---

Last reviewed: 2026-06-16.
