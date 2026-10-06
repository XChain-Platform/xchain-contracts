// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// test/fuzz/counterparty_bridge.test.js: seeded property fuzz of counterpartyBridge's feed parsing
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Drives randomly generated tokenscan "sends" pages through the real
// requestClaim -> onClaim round trip in the VM, and checks every outcome against
// a reference model written here, independent of the template's own helpers.
// The run is deterministic for a seed; set CP_BRIDGE_FUZZ_SEED to replay another.
//
// Run from the xchain-vm package so its deps (mocha, isolated-vm, mathjs) resolve:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/test/fuzz/counterparty_bridge.test.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', '..', 'xchain-vm');
const TEMPLATE = path.join(__dirname, '..', '..', 'counterpartyBridge', 'counterpartyBridge.js');
let XChainVM, E2EHarness;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
} catch (e) { XChainVM = null; console.log('Skipping counterpartyBridge fuzz: xchain-vm harness not available (need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(TEMPLATE, 'utf8');

const ADDR         = 'C:BTC:1';
const HOLDER       = '1HolderBtcAddress11111111111111111';
const OTHER        = '1OtherBtcAddress222222222222222222';
const CP_ASSET     = 'XCPCARD';
const XC_TICK      = 'BRIDGEDCARD';
const BURN_ADDRESS = '1BitcoinEaterAddressDontSendf59kuE';

// Keep the cap far above anything a run can mint (the cap path has its own example test).
const MAX_SUPPLY = '1000000000000';

const DEFAULT_SEED = 0x2f6b1c3d;
const SEED = process.env.CP_BRIDGE_FUZZ_SEED ? (Number(process.env.CP_BRIDGE_FUZZ_SEED) >>> 0) : DEFAULT_SEED;

// One deploy per entry, so every decimal grid the template allows gets truncation pressure.
const DECIMALS_PLAN = ['0', '2', '8', '18', '8'];
const ROUNDS_PER_DEPLOY = 30;
// Every period runs one corrupt-payload round and one failed-attestation round, by schedule.
const ROUND_KIND_PERIOD = 10;
const MAX_ROWS = 15;

// Scale used to compare raw feed quantities exactly; generated inputs carry at most 21 fraction digits.
const RAW_SCALE = 40;

// Reference eligibility for a quantity: plain fixed notation only (RegExp is fine in a test).
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

const BAD_SPELLINGS = ['1.5e-8', '1E3', '1e+21', '+1.5', '-5', '.5', '5.', ' 5', '5 ', '0x10', '0b101',
    '0o17', '1_000', '', 'NaN', 'Infinity', '-Infinity', '1.2.3', '1,5', '\t7', '٣'];
const MUTATION_CHARS = ['e', 'E', '+', '-', '_', 'x', '.', ',', ' ', '\n', 'a'];
const NUMBER_QUANTITIES = [42, 0, 7.25, 0.5, 1e21, 1e-7, 123456789, 2.5e-3, 0.1 + 0.2, 1e-6];
const CORRUPT_PAYLOADS = ['not json', 'null', '[]', '{"data":{}}', '{"data":null}', '{"data":"x"}', '{"total":3}'];

// Build mulberry32: a small seeded generator, so a failure replays from its seed alone.
function makeRng(seed) {
    let a = seed >>> 0;
    const next = function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next,
        int: (n) => Math.floor(next() * n),
        pick: (list) => list[Math.floor(next() * list.length)],
        chance: (p) => next() < p
    };
}

// Floor a plain decimal string to integer units of 10^-decimals, exactly.
function toUnits(text, decimals) {
    const parts = String(text).split('.');
    const frac = ((parts[1] || '') + '0'.repeat(decimals)).slice(0, decimals);
    return BigInt(parts[0]) * (10n ** BigInt(decimals)) + BigInt(frac || '0');
}

// Decide, independently of the template source, whether one feed row is a creditable burn.
function referenceEligible(row) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
    if (row.asset !== CP_ASSET || row.source !== HOLDER || row.status !== 'valid') return false;
    if (typeof row.tx_hash !== 'string' || row.tx_hash.length === 0) return false;
    if (row.quantity === undefined || row.quantity === null) return false;
    return PLAIN_DECIMAL.test(String(row.quantity));
}

// Generate a well-formed quantity, sometimes zero-padded, with 0-20 fraction digits.
function validDecimal(rng) {
    let whole = String(rng.int(10000001));
    if (rng.chance(0.1)) whole = '0'.repeat(1 + rng.int(3)) + whole;
    const fracLen = rng.int(21);
    let frac = '';
    for (let i = 0; i < fracLen; i++) frac += String(rng.int(10));
    return fracLen > 0 ? whole + '.' + frac : whole;
}

// Generate one quantity across every spelling class the feed could send.
function randomQuantity(rng) {
    const roll = rng.next();
    if (roll < 0.45) return validDecimal(rng);
    if (roll < 0.57) return rng.pick(BAD_SPELLINGS);
    if (roll < 0.72) {
        const base = validDecimal(rng);
        const at = rng.int(base.length + 1);
        return base.slice(0, at) + rng.pick(MUTATION_CHARS) + base.slice(at);
    }
    if (roll < 0.90) return rng.pick(NUMBER_QUANTITIES);
    return rng.pick([null, undefined, true, {}, 'abc']);
}

// Pick a tx_hash not yet used on this page: fresh, an already-credited one, or an earlier dropped one.
function pickTxHash(rng, run, usedOnPage) {
    const pools = [];
    if (rng.chance(0.15)) pools.push(Array.from(run.credited));
    if (rng.chance(0.15)) pools.push(Array.from(run.seenUncredited));
    for (const pool of pools) {
        const candidates = pool.filter((tx) => !usedOnPage.has(tx));
        if (candidates.length > 0) return rng.pick(candidates);
    }
    run.txCounter += 1;
    return 'fz' + SEED.toString(16) + 'x' + String(run.txCounter).padStart(56, '0');
}

// Build one feed row, then apply at most one kind of structural noise to it.
function randomRow(rng, run, usedOnPage) {
    const txHash = pickTxHash(rng, run, usedOnPage);
    usedOnPage.add(txHash);
    const row = {
        asset: CP_ASSET, asset_longname: '', block_index: 900000, destination: BURN_ADDRESS,
        quantity: randomQuantity(rng), source: HOLDER, status: 'valid',
        timestamp: 1700000000, tx_hash: txHash, tx_index: 1
    };
    if (!rng.chance(0.25)) return row;
    const noise = rng.int(5);
    if (noise === 0) row.asset = rng.pick(['OTHERASSET', CP_ASSET.toLowerCase(), '']);
    if (noise === 1) row.source = rng.pick([OTHER, BURN_ADDRESS, '']);
    if (noise === 2) row.status = rng.pick(['invalid', 'pending', 'VALID', '']);
    if (noise === 3) row.tx_hash = rng.pick([undefined, '', 42, null]);
    if (noise === 4) return rng.pick([null, 7, 'row', []]);
    return row;
}

// Build a page whose round kind is fixed by schedule, so every kind runs at any seed.
function buildRound(rng, run, round) {
    if (round % ROUND_KIND_PERIOD === 3) {
        const good = JSON.stringify({ data: [{ tx_hash: 'cut', quantity: '1' }], total: 1 });
        const payload = rng.chance(0.5) ? rng.pick(CORRUPT_PAYLOADS) : good.slice(0, rng.int(good.length));
        return { status: 'ok', payload, kind: 'corrupt' };
    }
    if (round % ROUND_KIND_PERIOD === 7) return { status: 'error', payload: '', kind: 'failed' };
    const usedOnPage = new Set();
    const rows = [];
    const rowCount = rng.int(MAX_ROWS + 1);
    for (let i = 0; i < rowCount; i++) rows.push(randomRow(rng, run, usedOnPage));
    return { status: 'ok', payload: JSON.stringify({ data: rows, total: rows.length }), kind: 'page' };
}

// Compute what onClaim must do for one round, from the reference rules alone.
function expectRound(page, run, decimals) {
    const expected = { units: 0n, rawScaled: 0n, credit: [], eligibleRows: 0 };
    if (page.status !== 'ok') return expected;
    let parsed;
    try { parsed = JSON.parse(page.payload); } catch (e) { return expected; }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.data)) return expected;
    for (const row of parsed.data) {
        if (!referenceEligible(row)) continue;
        expected.eligibleRows += 1;
        if (run.credited.has(row.tx_hash)) { run.stats.nullifierSkips += 1; continue; }
        const units = toUnits(String(row.quantity), decimals);
        if (units === 0n) continue;
        expected.units += units;
        expected.rawScaled += toUnits(String(row.quantity), RAW_SCALE);
        expected.credit.push(row.tx_hash);
    }
    return expected;
}

// Collect every string tx_hash a page carried, for the "dropped rows stay unmarked" check.
function pageTxHashes(page) {
    try {
        const parsed = JSON.parse(page.payload);
        if (!parsed || !Array.isArray(parsed.data)) return [];
        return parsed.data.filter((r) => r && typeof r.tx_hash === 'string' && r.tx_hash.length > 0)
            .map((r) => r.tx_hash);
    } catch (e) { return []; }
}

// Check the mint itself: exactly one MINT of the floored sum, never above the raw burn.
function checkMint(cb, expected, decimals, where) {
    if (expected.units === 0n) {
        assert.strictEqual(cb.emittedActions.length, 0, where + ': nothing to credit, yet actions were emitted');
        return;
    }
    assert.strictEqual(cb.emittedActions.length, 1, where + ': expected exactly one MINT');
    const mint = cb.emittedActions[0];
    assert.strictEqual(mint.action, 'MINT', where + ': emitted ' + mint.action + ' instead of MINT');
    assert.strictEqual(mint.params.tick, XC_TICK, where + ': minted the wrong tick');
    assert.strictEqual(mint.params.destination, HOLDER, where + ': minted to the wrong address');
    const qty = String(mint.params.quantity);
    assert.ok(PLAIN_DECIMAL.test(qty), where + ': mint quantity ' + qty + ' is not fixed notation');
    assert.ok((qty.split('.')[1] || '').length <= decimals, where + ': mint quantity ' + qty + ' is off the tick grid');
    assert.strictEqual(toUnits(qty, decimals), expected.units, where + ': minted ' + qty + ' but the reference expects ' +
        expected.units.toString() + ' units at ' + decimals + ' decimals');
    assert.ok(toUnits(qty, RAW_SCALE) <= expected.rawScaled, where + ': minted more than the eligible rows burned');
}

// Check state after the round: pending clears, nullifiers match credits, totals agree with the reference.
function checkState(state, page, expected, run, where) {
    assert.ok(!(('pending:' + HOLDER) in state), where + ': pending did not clear, so the address is wedged');
    for (const tx of expected.credit) {
        assert.strictEqual(state['burned:' + tx], true, where + ': credited burn ' + tx + ' was not marked');
    }
    const credit = new Set(expected.credit);
    for (const tx of pageTxHashes(page)) {
        if (credit.has(tx) || run.credited.has(tx)) continue;
        assert.ok(!(('burned:' + tx) in state), where + ': uncredited row ' + tx + ' was marked burned');
    }
    assert.strictEqual(toUnits(state.totalClaimed, RAW_SCALE), run.totalScaled, where + ': totalClaimed ' +
        state.totalClaimed + ' disagrees with the reference running total');
    const perHolder = state['claimedTotal:' + HOLDER] || '0';
    assert.strictEqual(toUnits(perHolder, RAW_SCALE), run.totalScaled, where + ': claimedTotal disagrees with totalClaimed');
    assert.ok(toUnits(state.totalClaimed, 0) <= BigInt(MAX_SUPPLY), where + ': totalClaimed passed maxSupply');
}

// Run one requestClaim -> onClaim round and check every property against the reference.
async function runRound(h, rng, run, decimals, where) {
    const page = buildRound(rng, run, run.round);
    const req = await h.execute({ contractAddress: ADDR, method: 'requestClaim', params: [], caller: HOLDER });
    assert.strictEqual(req.success, true, where + ': requestClaim failed: ' + req.error);
    const requestId = JSON.parse(req.returnValue);
    h.ledger.seedAttestation(requestId, {
        status: page.status, payload: page.payload, providerId: 'http_get', blockIndex: 200, validatorCount: 3
    });
    const expected = expectRound(page, run, decimals);
    const cb = await h.execute({ contractAddress: ADDR, method: 'onClaim', params: [requestId, 'http_get', 'ok', '', HOLDER], caller: HOLDER });
    const detail = where + ' [' + page.kind + '] payload ' + JSON.stringify(page.payload.slice(0, 300));
    assert.strictEqual(cb.success, true, detail + ': onClaim reverted: ' + cb.error);
    checkMint(cb, expected, decimals, detail);
    for (const tx of expected.credit) { run.credited.add(tx); run.seenUncredited.delete(tx); }
    for (const tx of pageTxHashes(page)) if (!run.credited.has(tx)) run.seenUncredited.add(tx);
    run.totalScaled += expected.units * (10n ** BigInt(RAW_SCALE - decimals));
    checkState(h.ledger.getContractState(ADDR), page, expected, run, detail);
    run.stats[page.kind] += 1;
    if (expected.units > 0n) run.stats.mints += 1;
    if (page.kind === 'page' && expected.eligibleRows < JSON.parse(page.payload).data.length) run.stats.droppedRows += 1;
}

const stats = { page: 0, corrupt: 0, failed: 0, mints: 0, droppedRows: 0, nullifierSkips: 0 };

(XChainVM ? describe : describe.skip)('Template: counterpartyBridge feed-parse fuzz (seeded)', function () {
    this.timeout(0);
    const rng = makeRng(SEED);

    DECIMALS_PLAN.forEach(function (decimals, deployIndex) {
        it('decimals ' + decimals + ': ' + ROUNDS_PER_DEPLOY + ' random claim rounds hold every property (seed ' + SEED + ')', async function () {
            const h = new E2EHarness(XChainVM);
            await h.deploy({ code: CODE, deployer: HOLDER, contractAddress: ADDR, params: [CP_ASSET, XC_TICK, MAX_SUPPLY, decimals] });
            const run = { round: 0, txCounter: deployIndex * 1000, credited: new Set(), seenUncredited: new Set(), totalScaled: 0n, stats };
            for (run.round = 0; run.round < ROUNDS_PER_DEPLOY; run.round++) {
                await runRound(h, rng, run, Number(decimals), 'seed ' + SEED + ' deploy ' + deployIndex + ' round ' + run.round);
            }
        });
    });

    // Prove the generator reached every class it claims to, so a green run is not an empty one.
    it('the run exercised mints, dropped rows, nullifier re-sends, corrupt and failed responses', function () {
        assert.ok(stats.page > 0 && stats.mints > 0, 'no page minted anything: ' + JSON.stringify(stats));
        assert.ok(stats.droppedRows > 0, 'no page carried an ineligible row: ' + JSON.stringify(stats));
        assert.ok(stats.nullifierSkips > 0, 'no already-credited burn was re-sent: ' + JSON.stringify(stats));
        assert.ok(stats.corrupt > 0 && stats.failed > 0, 'corrupt or failed responses never ran: ' + JSON.stringify(stats));
    });
});
