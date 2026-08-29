# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- Corrected a 0.11.0 release note that claimed an English auction leader's self-raise no longer reverts; it still reverts, and a top-up batched behind the rejected bid stays in the contract (see "Known limitations" in `englishAuction/README.md`).
- Corrected the 0.11.0 deployer-integer note, which omitted englishAuction from the templates whose constructor integers gained canonical range validation.

## [0.11.0] - 2026-08-25

### Added
- stableVault's initialize now accepts a stableDecimals parameter (0-18, default 8) to set the decimal grid of the stable asset it issues.

### Fixed
- Deployer-supplied integer parameters (deadlines, durations, decimals) across escrow, escrowDelivery, vesting, crowdsale, dutchAuction, and englishAuction are now validated as canonical in-range integers, closing a gap where a malformed value could deploy a contract on terms the deployer never intended.
- escrowDelivery no longer accepts a malformed deadline that could let a buyer bypass the seller/arbiter settlement path and reclaim the full escrowed balance early.
- The card dispenser no longer advances a buyer's paid counter past refunded or swept balances.

