// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// isolate_probe.js: deploy and execute one trivial contract inside a real isolate.
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Requiring xchain-vm proves nothing about the native binding: isolated-vm only
// dlopens when an isolate is constructed. bin/ci-preflight.js and
// test/preflight.test.js both call this one probe, so the two cannot drift.
// It never catches: every failure must reach the caller.

'use strict';

const ADDR   = 'C:BTC:PREFLIGHT';
const CALLER = 'preflight_addr';
const CODE   = 'module.exports = function (xchain) { return "ok"; };';

// Pass the harness's own default mode explicitly, which silences the VM's stderr warning.
function inProcessVM(XChainVM) {
    return class InProcessVM extends XChainVM {
        constructor(config) { super({ ...config, execution: 'in-process' }); }
    };
}

// Throw unless deploy and execute both succeeded and the contract returned 'ok'.
async function runIsolateProbe(XChainVM, E2EHarness) {
    const h = new E2EHarness(inProcessVM(XChainVM));
    const deployed = await h.deploy({ code: CODE, deployer: CALLER, contractAddress: ADDR });
    if (!deployed || deployed.success !== true)
        throw new Error('trivial contract failed to deploy: ' + (deployed && deployed.error));
    const r = await h.execute({ contractAddress: ADDR, method: 'default', params: [], caller: CALLER });
    if (!r || r.success !== true)
        throw new Error('trivial contract failed to execute: ' + (r && r.error));
    if (JSON.parse(r.returnValue) !== 'ok')
        throw new Error('trivial contract returned ' + r.returnValue + ', expected "ok"');
}

module.exports = { runIsolateProbe };
