// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// amm.test.js: behavioral + adversarial tests for amm.js (incl. k-invariant fuzz)
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Loads the ACTUAL amm.js and runs it through xchain-vm's E2E harness
// (isolated-vm / Node 22). Run from the xchain-vm package:
//   cd xchain-vm && npx mocha --timeout 0 ../xchain-contracts/amm/amm.test.js
//
// MockIndexer notes: SEND moves custody->recipient (asserted via balances), but
// MINT credits the contract & ignores `destination` and ISSUE is a no-op. So LP
// minting is asserted via the emitted MINT action, and for removeLiquidity the
// provider's LP balance is seeded manually (what the real indexer's mint would do)
// before depositing it back.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, math;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
    const { create, all } = require(path.join(VM_DIR, 'node_modules', 'mathjs'));
    math = create(all, { number: 'BigNumber', precision: 64 });
} catch (e) { XChainVM = null; console.log('Skipping AMM tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'amm.js'), 'utf8');

const LP1 = 'lp1', LP2 = 'lp2', T1 = 'trader1';
const ADDR = 'C:BTC:1', A = 'AAA', B = 'BBB', LP = 'AAABBBLP';

const bn = (x) => math.bignumber(x);
const k = (r) => math.multiply(bn(r.a), bn(r.b));

// ABI metadata (spec: xchain-documentation/protocol/contract-abi.md). Static
// module surface; no VM harness needed, so this suite always runs.
describe('Template: amm abi', function () {
    const abi = require('./amm.js').abi;

    it('declares an abi block covering every public method', function () {
        assert.strictEqual(abi.version, 1);
        assert.deepStrictEqual(Object.keys(abi.methods).sort(),
            ['addLiquidity', 'info', 'removeLiquidity', 'swap']);
    });

    it('declares swap params in wire order with valid types', function () {
        assert.deepStrictEqual(abi.methods.swap.params,
            [{ name: 'tokenIn', type: 'tick' }, { name: 'minOut', type: 'amount' }]);
        assert.deepStrictEqual(abi.methods.addLiquidity.params, []);
        assert.deepStrictEqual(abi.methods.removeLiquidity.params, []);
        assert.strictEqual(abi.methods.info.view, true);
    });
});

(XChainVM ? describe : describe.skip)('Template: amm', function () {
    this.timeout(0);
    let h;

    async function deploy() {
        h = new E2EHarness(XChainVM);
        for (const u of [LP1, LP2, T1]) {
            h.seedBalance(u, 'XCHAIN', '100000000');
            h.seedBalance(u, A, '100000000');
            h.seedBalance(u, B, '100000000');
        }
        // The real indexer knows each tick's decimals: it exposes them to the contract
        // (getTokenInfo) and truncates emitted amounts to them at write time. Register
        // the pair + LP tick at 8 dp so the harness models both.
        h.ledger.setTokenDecimals(A, 8);
        h.ledger.setTokenDecimals(B, 8);
        h.ledger.setTokenDecimals(LP, 8);
        return h.deploy({ code: CODE, deployer: LP1, contractAddress: ADDR, params: [A, B, LP] });
    }
    async function addLiq(who, a, b) {
        h.deposit(who, ADDR, A, a); h.deposit(who, ADDR, B, b);
        return h.execute({ contractAddress: ADDR, method: 'addLiquidity', params: [], caller: who });
    }
    async function swap(who, tokenIn, amt, minOut) {
        h.deposit(who, ADDR, tokenIn, amt);
        return h.execute({ contractAddress: ADDR, method: 'swap', params: [tokenIn, String(minOut == null ? '0' : minOut)], caller: who });
    }
    function reserves() { const s = h.ledger.getContractState(ADDR); return { a: s.reserveA, b: s.reserveB, shares: s.totalShares }; }
    function emitted(result, action, tick) {
        return result.emittedActions.find(e => e.action === action && (!tick || e.params.tick === tick));
    }

    describe('liquidity', function () {
        it('first provider mints sqrt(a*b) shares and sets reserves', async function () {
            assertSuccess(await deploy());
            const r = await addLiq(LP1, '1000', '1000');
            assertSuccess(r);
            const mint = emitted(r, 'MINT', LP);
            assert.ok(mint && mint.params.destination === LP1, 'LP minted to provider');
            assert.strictEqual(mint.params.quantity, '1000', 'sqrt(1000*1000) = 1000 shares');
            assert.deepStrictEqual(reserves(), { a: '1000', b: '1000', shares: '1000' });
        });

        it('later providers mint shares proportional to the scarcer side', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            const r = await addLiq(LP2, '500', '500');
            assert.strictEqual(emitted(r, 'MINT', LP).params.quantity, '500');
            assert.deepStrictEqual(reserves(), { a: '1500', b: '1500', shares: '1500' });
        });

        it('removeLiquidity burns shares and returns a proportional slice', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            // Mock-indexer quirk: its MINT credits the contract, not `destination`.
            // The real indexer pays the provider, so reset the contract's LP custody
            // to 0 and credit LP1 the shares the mint actually represents.
            h.ledger.contractBalances[ADDR][LP] = '0';
            h.ledger.setBalance(LP1, LP, '1000');
            h.deposit(LP1, ADDR, LP, '1000'); // return all shares
            const r = await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 });
            assertSuccess(r);
            assert.ok(emitted(r, 'DESTROY', LP), 'shares burned');
            assert.strictEqual(emitted(r, 'SEND', A).params.quantity, '1000');
            assert.strictEqual(emitted(r, 'SEND', B).params.quantity, '1000');
            assert.deepStrictEqual(reserves(), { a: '0', b: '0', shares: '0' });
        });

        it('partial removeLiquidity returns the right fraction', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            h.ledger.contractBalances[ADDR][LP] = '0'; // see note above
            h.ledger.setBalance(LP1, LP, '1000');
            h.deposit(LP1, ADDR, LP, '400');
            const r = await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 });
            assert.strictEqual(emitted(r, 'SEND', A).params.quantity, '400');
            assert.strictEqual(emitted(r, 'SEND', B).params.quantity, '400');
            assert.deepStrictEqual(reserves(), { a: '600', b: '600', shares: '600' });
        });

        it('one-sided liquidity is rejected', async function () {
            await deploy();
            h.deposit(LP1, ADDR, A, '1000'); // only A
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'addLiquidity', params: [], caller: LP1 }),
                'must deposit both');
        });
    });

    describe('swap', function () {
        it('charges the fee, pays out, and keeps reserves consistent (k grows)', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            const before = reserves();
            const r = await swap(T1, A, '100', '0');
            assertSuccess(r);

            const out = emitted(r, 'SEND', B).params.quantity;
            assert.ok(math.larger(bn(out), bn('0')), 'positive output');
            // No-fee output would be 1000 - 1000*1000/1100 = 90.909...; the fee makes it less.
            assert.ok(math.smaller(bn(out), bn('90.9091')), 'fee reduces output below the no-fee price');

            const after = reserves();
            // reserveA += full input; reserveB -= exactly the paid-out amount.
            assert.strictEqual(after.a, '1100');
            assert.ok(math.equal(bn(after.b), math.subtract(bn(before.b), bn(out))), 'reserveB == old - out');
            assert.ok(math.largerEq(k(after), k(before)), 'k is non-decreasing');
        });

        it('reverts when the output would fall below minOut (slippage)', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            assertReverted(await swap(T1, A, '100', '95'), 'slippage');
        });

        it('cannot be drained: a huge swap still leaves the output reserve positive', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            const r = await swap(T1, A, '1000000', '0');
            assertSuccess(r);
            assert.ok(math.larger(bn(reserves().b), bn('0')), 'output reserve never hits zero');
        });

        it('rejects a tokenIn that is not in the pair', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            h.deposit(T1, ADDR, A, '100');
            assertReverted(await h.execute({ contractAddress: ADDR, method: 'swap', params: ['ZZZ', '0'], caller: T1 }),
                'tokenIn not in pair');
        });

        it('reverts swapping into an empty pool', async function () {
            await deploy();
            assertReverted(await swap(T1, A, '100', '0'), 'no liquidity');
        });
    });

    describe('precision reconciliation (finding: reserves/totalShares drift)', function () {
        // Half-up normalization to d decimals == what the indexer stores on the ledger
        // (mathjs.format fixed-notation, the same call util.bcadd makes; half-up, not
        // banker's/half-even, pinned by xchain-indexer/test/unit/xchainPrice.test.js).
        const norm = (v, d) => math.format(bn(v), { notation: 'fixed', precision: d });
        // Fractional-digit count; a value with <= d fraction digits sits on the tick grid,
        // so the indexer's write-time re-normalization is a numeric no-op.
        const fracLen = (v) => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
        const onGrid = (v, d) => fracLen(v) <= d;

        it('quantises totalShares to the LP grid so the last LP fully drains', async function () {
            await deploy();
            // sqrt(1000 * 3000) = 1732.05080756887... : off the 8-dp grid.
            const r1 = await addLiq(LP1, '1000', '3000');
            assertSuccess(r1);
            const mint1 = emitted(r1, 'MINT', LP).params.quantity;
            assert.ok(onGrid(reserves().shares, 8),
                'totalShares must sit on the 8-dp LP grid, got ' + reserves().shares);
            assert.ok(math.equal(bn(reserves().shares), bn(norm(mint1, 8))),
                'state totalShares must equal the LP supply the indexer actually mints');

            // Second provider deposits in-ratio; the proportional share repeats.
            const r2 = await addLiq(LP2, '333', '999');
            assertSuccess(r2);
            const mint2 = emitted(r2, 'MINT', LP).params.quantity;
            assert.ok(onGrid(reserves().shares, 8), 'totalShares stays gridded after the 2nd add');
            assert.ok(math.equal(bn(reserves().shares), math.add(bn(norm(mint1, 8)), bn(norm(mint2, 8)))),
                'totalShares == sum of minted LP');

            // Both LPs redeem everything; the pool must drain to exactly zero. The bug
            // divided by an inflated totalShares, so the final dust was unwithdrawable.
            h.ledger.contractBalances[ADDR][LP] = '0'; // undo the mock MINT-to-contract quirk
            h.ledger.setBalance(LP2, LP, mint2);
            h.deposit(LP2, ADDR, LP, mint2);
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP2 }));
            assert.ok(onGrid(reserves().a, 8) && onGrid(reserves().b, 8), 'reserves gridded after partial exit');

            h.ledger.setBalance(LP1, LP, mint1);
            h.deposit(LP1, ADDR, LP, mint1);
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 }));
            assert.deepStrictEqual(reserves(), { a: '0', b: '0', shares: '0' }, 'last LP drains the pool to zero');
        });

        it('quantises swap output so reserves reconcile with token custody', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            const r = await swap(T1, A, '100', '0');
            assertSuccess(r);
            const out = emitted(r, 'SEND', B).params.quantity;
            assert.ok(onGrid(out, 8), 'swap output is 8-dp gridded, got ' + out);
            assert.ok(onGrid(reserves().b, 8), 'reserveB stays on the 8-dp grid, got ' + reserves().b);
        });
    });

    describe('k-invariant fuzz', function () {
        it('k never decreases across a long mixed swap sequence', async function () {
            await deploy();
            await addLiq(LP1, '1000000', '1000000');
            // Deterministic, varied sequence in both directions and sizes.
            const ops = [
                [A, '1000'], [B, '500'], [A, '25000'], [B, '12345'], [A, '7'],
                [B, '999999'], [A, '333'], [B, '88888'], [A, '1'], [B, '450000'],
                [A, '60000'], [B, '3']
            ];
            let prev = k(reserves());
            for (let i = 0; i < ops.length; i++) {
                const [tin, amt] = ops[i];
                assertSuccess(await swap(T1, tin, amt, '0'));
                const now = k(reserves());
                assert.ok(math.largerEq(now, prev),
                    `k decreased at op ${i} (${tin} ${amt}): ${now.toString()} < ${prev.toString()}`);
                prev = now;
            }
        });
    });
});
