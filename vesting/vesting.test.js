// SPDX-License-Identifier: MIT
//
// XChain Platform — Contract Template Library
// vesting.test.js — behavioral + adversarial tests for vesting.js
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Loads the ACTUAL vesting.js template and runs it through xchain-vm's E2E
// harness (isolated-vm / Node 22). Run from the xchain-vm package:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/vesting/vesting.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM;
try { XChainVM = require(path.join(VM_DIR, 'src', 'index.js')); }
catch (e) { console.log('Skipping vesting tests — isolated-vm not available (need Node 22)'); }

const { E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js'));
const { assertSuccess, assertReverted, assertEmittedActions, assertBalance }
        = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js'));

const CODE = fs.readFileSync(path.join(__dirname, 'vesting.js'), 'utf8');

const GRANTOR = 'grantor';
const BENE    = 'beneficiary';
const STRANGER = 'stranger';
const ADDR    = 'C:BTC:1';
const TICK    = 'TEST';

// total=1000, cliff=10, duration=100 → linear; clean round numbers.
const TOTAL = '1000', CLIFF = 10, DURATION = 100;

(XChainVM ? describe : describe.skip)('Template: vesting', function () {
    this.timeout(0);
    let h;

    async function deploy(revocable, total) {
        h = new E2EHarness(XChainVM);
        h.seedBalance(GRANTOR, 'XCHAIN', '1000000');
        h.seedBalance(GRANTOR, TICK, '1000');
        await h.deploy({
            code: CODE, deployer: GRANTOR, contractAddress: ADDR,
            params: [GRANTOR, BENE, TICK, total || TOTAL, String(CLIFF), String(DURATION), revocable || 'false']
        });
    }
    async function fund(amount) {
        h.deposit(GRANTOR, ADDR, TICK, amount || TOTAL);
        return h.execute({ contractAddress: ADDR, method: 'fund', params: [], caller: GRANTOR });
    }
    // Jump to a precise elapsed-since-start block (fund() starts the clock at height 1).
    function atElapsed(e) { h.ledger.blockHeight = 1 + e; }
    function claim(who) { return h.execute({ contractAddress: ADDR, method: 'claim', params: [], caller: who || BENE }); }

    describe('linear accrual', function () {
        it('nothing is claimable before the cliff', async function () {
            await deploy(); await fund();
            atElapsed(CLIFF - 1);
            assertReverted(await claim(), 'nothing to claim');
        });

        it('the cliff chunk unlocks, then it vests linearly to the full grant', async function () {
            await deploy(); await fund();

            atElapsed(CLIFF);                 // 10/100 → 100 vested
            let r = await claim();
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '100' } }]);

            atElapsed(50);                    // 500 vested, 100 already claimed → 400
            r = await claim();
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '400' } }]);

            atElapsed(DURATION);              // fully vested → remaining 500
            r = await claim();
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '500' } }]);

            assertBalance(h.ledger, BENE, TICK, '1000'); // got exactly the grant, no more
        });

        it('over-vesting past the duration never pays more than the grant', async function () {
            await deploy(); await fund();
            atElapsed(DURATION * 5);
            const r = await claim();
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '1000' } }]);
        });
    });

    describe('attacks we considered', function () {
        it('fund() rejects an underfunded deposit', async function () {
            await deploy();
            assertReverted(await fund('500'), 'insufficient deposit');
        });

        it('only the beneficiary can claim', async function () {
            await deploy(); await fund(); atElapsed(CLIFF);
            assertReverted(await claim(STRANGER), 'only the beneficiary');
            assertReverted(await claim(GRANTOR), 'only the beneficiary');
        });

        it('double-claim in the same block yields nothing the second time', async function () {
            await deploy(); await fund(); atElapsed(50);
            assertSuccess(await claim());
            assertReverted(await claim(), 'nothing to claim');
        });

        it('claim before funding reverts', async function () {
            await deploy();
            assertReverted(await claim(), 'vesting not active');
        });
    });

    describe('revocation', function () {
        it('grantor reclaims the unvested portion; beneficiary keeps the vested', async function () {
            await deploy('true'); await fund();
            atElapsed(30);                    // 300 vested, 700 unvested
            const r = await h.execute({ contractAddress: ADDR, method: 'revoke', params: [], caller: GRANTOR });
            assertSuccess(r);
            assertEmittedActions(r, [{ action: 'SEND', params: { destination: GRANTOR, tick: TICK, quantity: '700' } }]);

            // Beneficiary can still claim the frozen 300 — but no more accrues.
            atElapsed(90);
            const c = await claim();
            assertEmittedActions(c, [{ action: 'SEND', params: { destination: BENE, tick: TICK, quantity: '300' } }]);
            assertReverted(await claim(), 'nothing to claim'); // cap is frozen at 300
        });

        it('a non-grantor cannot revoke', async function () {
            await deploy('true'); await fund(); atElapsed(30);
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'revoke', params: [], caller: STRANGER }),
                'only the grantor');
        });

        it('a non-revocable grant cannot be revoked', async function () {
            await deploy('false'); await fund(); atElapsed(30);
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'revoke', params: [], caller: GRANTOR }),
                'not revocable');
        });

        it('a fully-vested grant has nothing to revoke', async function () {
            await deploy('true'); await fund(); atElapsed(DURATION);
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'revoke', params: [], caller: GRANTOR }),
                'nothing to revoke');
        });
    });

    describe('deploy-time validation', function () {
        async function badDeploy(params) {
            const b = new E2EHarness(XChainVM);
            b.seedBalance(GRANTOR, 'XCHAIN', '1000000');
            return b.deploy({ code: CODE, deployer: GRANTOR, contractAddress: 'C:BTC:9', params });
        }
        it('rejects total <= 0', async function () {
            assert.strictEqual((await badDeploy([GRANTOR, BENE, TICK, '0', '10', '100', 'false'])).success, false);
        });
        it('rejects cliff > duration', async function () {
            assert.strictEqual((await badDeploy([GRANTOR, BENE, TICK, '1000', '200', '100', 'false'])).success, false);
        });
        it('rejects a non-boolean revocable flag', async function () {
            assert.strictEqual((await badDeploy([GRANTOR, BENE, TICK, '1000', '10', '100', 'maybe'])).success, false);
        });
    });
});
