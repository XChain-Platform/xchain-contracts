# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.15.0] - 2026-09-04

### Fixed
- dutchAuction's `buy()` now reverts when the decayed asking price floors below one unit of the bid token's decimal grid, closing a path that handed the item to a caller who paid nothing.
- priceBetTimed's `accept()` now refuses a match on a pair with no readable oracle tip, closing a path where the scan cursor started below the host's preload floor and locked both stakes permanently.
- The cardDispenser deploy note reflects the wired balance reader.
- Corrected a 0.11.0 release note that claimed an English auction leader's self-raise no longer reverts; it still reverts, and a top-up batched behind the rejected bid stays in the contract (see "Known limitations" in `englishAuction/README.md`).
- Corrected the 0.11.0 deployer-integer note, which omitted englishAuction from the templates whose constructor integers gained canonical range validation.
- Corrected the custody documentation across the library README and every template: a `BATCH(DEPOSIT, EXECUTE)` is not atomic, and a reverted `EXECUTE` leaves the `DEPOSIT` standing; "atomic" now means only the intra-`EXECUTE` state-and-emission scope.
- amm's README documents the stranded-deposit footgun under "Attacks we considered", and `amm.test.js` pins it: a reverted `swap()` leaves its deposit in pool custody and the next trader is credited it.

## [0.11.0] - 2026-08-25

### Added
- stableVault's initialize now accepts a stableDecimals parameter (0-18, default 8) to set the decimal grid of the stable asset it issues.

### Fixed
- Deployer-supplied integer parameters (deadlines, durations, decimals) across escrow, escrowDelivery, vesting, crowdsale, dutchAuction, and englishAuction are now validated as canonical in-range integers, closing a gap where a malformed value could deploy a contract on terms the deployer never intended.
- escrowDelivery no longer accepts a malformed deadline that could let a buyer bypass the seller/arbiter settlement path and reclaim the full escrowed balance early.
- The card dispenser no longer advances a buyer's paid counter past refunded or swept balances.

