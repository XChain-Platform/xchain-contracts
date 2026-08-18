#!/usr/bin/env bash
#*********************************************************************
#
# Copyright © 2025-2026 Dankest, LLC
# Based on XChain Platform by Dankest, LLC - https://dankest.llc
#
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# This file is part of XChain Platform. Licensed under the GNU Affero
# General Public License v3.0 or later; see LICENSE.md. A commercial
# license (without AGPL source-disclosure terms) is available -
# contact legal@dankest.llc.
#
#*********************************************************************

#
# bin/ci-full.sh: run EVERY tier this repo's GitHub CI runs, in one process.
#
# .github/workflows/ci.yml runs xchain-contracts as a single job (ci), but that
# job first checks out a sibling xchain-vm and installs ITS dependencies
# (isolated-vm builds natively) before `npm run ci` can even load the harness
# (see bin/ci-preflight.js, which fails loud rather than letting the suites
# quietly `describe.skip` on a missing/unbuilt sibling). The pre-push venue
# gate used to run only `npm test`, which never proved the preflight or the
# lint tier, and this repo had no .ci-siblings entry at all, so a locally-green
# push could still miss the exact gap CI checks for. This script IS the local
# twin of the workflow's one job. When ci.yml gains or changes a job, change
# this script in the same commit.
#
# Layout: siblings resolve at ../<repo>, which is both the platform monorepo
# layout and the venue gate's work/ layout. .ci-siblings ships xchain-vm there
# AND installs its dependencies (npm ci --ignore-scripts), which is what makes
# the workflow's own "Install xchain-vm dependencies" step unnecessary here. A
# sibling a GitHub job checks out is REQUIRED here: missing means fail loud,
# never skip, because GitHub will run the step this gate would be skipping.
#
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SIB="$(cd .. && pwd)"

FAILED=""
run_tier() {
  local name="$1"; shift
  echo; echo "ci:full ===== $name ====="
  if "$@"; then
    echo "ci:full ----- $name PASS"
  else
    FAILED="$FAILED [$name]"
    echo "ci:full ----- $name FAIL"
  fi
}
need_sib() {
  local s
  for s in "$@"; do
    if [ ! -d "$SIB/$s" ]; then
      echo "ci:full: MISSING SIBLING $SIB/$s" >&2
      echo "ci:full: GitHub CI checks this sibling out and runs steps against it," >&2
      echo "ci:full: so skipping here would gate green on a subset. Declare it in" >&2
      echo "ci:full: .ci-siblings (venue) or clone it beside this repo (hand run)." >&2
      exit 1
    fi
  done
}

need_sib xchain-vm

# --- job: ci -----------------------------------------------------------
# The workflow's single job: checkout xchain-vm, install its deps, install
# this repo's deps, then `npm run ci` (ci-preflight.js && npm test && npm run
# lint). The install steps map to .ci-siblings on the venue.
run_tier "ci (ci-preflight + test + lint)" npm run ci

echo
if [ -n "$FAILED" ]; then
  echo "ci:full: RED tiers:$FAILED"
  exit 1
fi
echo "ci:full: all tiers green (same set GitHub CI runs)"
