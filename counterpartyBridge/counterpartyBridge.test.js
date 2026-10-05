// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// counterpartyBridge.test.js: behavioral + adversarial tests for counterpartyBridge.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs against the real VM via xchain-vm's E2E harness (isolated-vm / Node 22).
// Loads the ACTUAL counterpartyBridge.js template (no copy), so the test can
// never drift.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/counterpartyBridge/counterpartyBridge.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registerHappyPathTests = require('./counterparty_bridge_test/happy_path_tests');
const registerNoBurnFailureTests = require('./counterparty_bridge_test/no_burn_failure_tests');
const registerAttackTests = require('./counterparty_bridge_test/attack_tests');
const registerQuantityParseTests = require('./counterparty_bridge_test/quantity_parse_tests');
const registerDeployValidationTests = require('./counterparty_bridge_test/deploy_validation_tests');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertEmittedActions, assertContractState;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertEmittedActions, assertContractState }
       = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
} catch (e) { XChainVM = null; console.log('Skipping counterpartyBridge tests: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'counterpartyBridge.js'), 'utf8');

const ADDR         = 'C:BTC:1';
const HOLDER       = '1HolderBtcAddress11111111111111111';
const OTHER        = '1OtherBtcAddress222222222222222222';
const CP_ASSET     = 'XCPCARD';
const XC_TICK      = 'BRIDGEDCARD';
const MAX_SUPPLY   = '1000000';
const BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE';

let txCounter = 0;
function nextTxHash() { txCounter += 1; return 'tx' + String(txCounter).padStart(62, '0'); }

(XChainVM ? describe : describe.skip)('Template: counterpartyBridge', function () {
    this.timeout(0);
    let h;

    async function deployBridge(maxSupply, decimals) {
        h = new E2EHarness(XChainVM);
        await h.deploy({
            code: CODE, deployer: HOLDER, contractAddress: ADDR,
            params: [CP_ASSET, XC_TICK, maxSupply || MAX_SUPPLY, decimals || '8']
        });
    }

    // Seeds a settled attestation response on the harness's MockLedger, the
    // way the indexer would after off-chain providers agree on the sends
    // API's body. h.execute() reads it via ledger.buildAttestationAccessor().
    function seedSendsResponse(requestId, payload, status) {
        h.ledger.seedAttestation(requestId, {
            status: status || 'ok', payload: payload, providerId: 'http_get', blockIndex: 200, validatorCount: 3
        });
    }

    // Shape of a real tokenscan.io GET /api/sends/{address}/{page}/{limit}
    // response (see https://tokenscan.io/api#sends): every Send that ever
    // landed on BURN_ADDRESS, across every asset and every sender.
    function sendsPayload(rows) {
        return JSON.stringify({
            data: rows.map(function (r) {
                return {
                    asset: r.asset || CP_ASSET,
                    asset_longname: '',
                    block_index: r.blockIndex || 900000,
                    destination: BURN_ADDRESS,
                    quantity: r.quantity,
                    source: r.source || HOLDER,
                    status: r.status || 'valid',
                    timestamp: 1700000000,
                    tx_hash: r.txHash,
                    tx_index: r.txIndex || 1
                };
            }),
            total: rows.length
        });
    }

    const context = {
        ADDR,
        HOLDER,
        OTHER,
        CP_ASSET,
        XC_TICK,
        MAX_SUPPLY,
        CODE,
        XChainVM,
        E2EHarness,
        assert,
        assertSuccess,
        assertReverted,
        assertEmittedActions,
        assertContractState,
        deployBridge,
        getHarness: function () { return h; },
        seedSendsResponse,
        sendsPayload,
        nextTxHash
    };

    registerHappyPathTests(context);
    registerNoBurnFailureTests(context);
    registerAttackTests(context);
    registerQuantityParseTests(context);
    registerDeployValidationTests(context);
});
