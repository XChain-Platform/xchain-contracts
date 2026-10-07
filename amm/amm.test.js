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
// MockIndexer notes: ISSUE is a no-op, so deploy() credits the pre-minted LP
// inventory to contract custody by hand. SEND then moves shares to providers.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const VM_DIR = path.join(__dirname, '..', '..', 'xchain-vm');
let XChainVM, E2EHarness, assertSuccess, assertReverted, assertContractBalance, assertContractState, math;
try {
    XChainVM = require(path.join(VM_DIR, 'src', 'index.js'));
    ({ E2EHarness } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'harness.js')));
    ({ assertSuccess, assertReverted, assertContractBalance, assertContractState } = require(path.join(VM_DIR, 'test', 'e2e', 'helpers', 'assertions.js')));
    const { create, all } = require(path.join(VM_DIR, 'node_modules', 'mathjs'));
    math = create(all, { number: 'BigNumber', precision: 64 });
} catch (e) { XChainVM = null; console.log('Skipping AMM tests (xchain-vm harness not available, need adjacent xchain-vm install on Node 22)'); }

const CODE = fs.readFileSync(path.join(__dirname, 'amm.js'), 'utf8');

const LP1 = 'lp1', LP2 = 'lp2', T1 = 'trader1';
const ADDR = 'C:BTC:1', A = 'AAA', B = 'BBB', LP = 'AAABBBLP';
const LP_MAX_SUPPLY = '99999999999999999999';

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
        const deployed = await h.deploy({ code: CODE, deployer: LP1, contractAddress: ADDR, params: [A, B, LP] });
        h.ledger.creditContractBalance(ADDR, LP, LP_MAX_SUPPLY);
        return deployed;
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
        it('first provider mints sqrt(a*b) shares less the locked minimum and sets reserves', async function () {
            assertSuccess(await deploy());
            const r = await addLiq(LP1, '1000', '1000');
            assertSuccess(r);
            const delivery = emitted(r, 'SEND', LP);
            assert.ok(delivery && delivery.params.destination === LP1, 'LP delivered to provider');
            assert.strictEqual(delivery.params.quantity, '999.999', 'sqrt(1000*1000) = 1000 shares, MINIMUM_LIQUIDITY locked');
            assert.deepStrictEqual(reserves(), { a: '1000', b: '1000', shares: '1000' });
        });

        it('locks public LP minting and distributes only pre-minted custody', async function () {
            const deployed = await deploy();
            const issues = deployed.result.emittedActions.filter(e => e.action === 'ISSUE');
            assert.strictEqual(issues.length, 1);
            assert.strictEqual(issues[0].params.mintSupply, LP_MAX_SUPPLY);
            assert.strictEqual(issues[0].params.maxSupply, LP_MAX_SUPPLY);
            assert.strictEqual(issues[0].params.lockMint, '1');
            assert.strictEqual(issues[0].params.lockMintSupply, '1');
            assert.strictEqual(CODE.indexOf('emit.mint'), -1, 'AMM methods never invoke locked MINT');

            const added = await addLiq(LP1, '1000', '1000');
            assertSuccess(added);
            assert.strictEqual(emitted(added, 'MINT', LP), undefined);
            assert.strictEqual(emitted(added, 'SEND', LP).params.quantity, '999.999');
            assert.strictEqual(h.ledger.getContractState(ADDR).lpInventory, '99999999999999998999.001');
        });

        it('locks MINIMUM_LIQUIDITY on the first deposit so the pool never drains to zero shares', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            h.deposit(LP1, ADDR, LP, '999.999');
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 }));
            const r = reserves();
            assert.strictEqual(r.shares, '0.001', 'locked shares stay in totalShares');
            assert.ok(math.larger(bn(r.a), 0) && math.larger(bn(r.b), 0), 'locked share keeps a reserve behind');
        });

        it('rejects a first deposit that does not exceed MINIMUM_LIQUIDITY', async function () {
            await deploy();
            assertReverted(await addLiq(LP1, '0.001', '0.001'), 'insufficient liquidity minted');
        });

        it('a one-unit first position plus a donation cannot zero out a later depositor', async function () {
            await deploy();
            assertReverted(await addLiq(LP1, '0.00000001', '0.00000001'), 'insufficient liquidity minted');
            await addLiq(LP1, '1000', '1000');
            h.deposit(LP1, ADDR, A, '1000000'); // direct donation, not accounted until next add
            const r = await addLiq(LP2, '1000', '1000');
            assertSuccess(r);
            assert.ok(math.larger(bn(emitted(r, 'SEND', LP).params.quantity), 0));
        });

        it('later providers mint shares proportional to the scarcer side', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            const r = await addLiq(LP2, '500', '500');
            assert.strictEqual(emitted(r, 'SEND', LP).params.quantity, '500');
            assert.deepStrictEqual(reserves(), { a: '1500', b: '1500', shares: '1500' });
        });

        it('removeLiquidity burns shares and returns a proportional slice', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            h.deposit(LP1, ADDR, LP, '999.999'); // return all minted shares
            const r = await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 });
            assertSuccess(r);
            assert.ok(emitted(r, 'DESTROY', LP), 'shares burned');
            assert.strictEqual(emitted(r, 'SEND', A).params.quantity, '999.999');
            assert.strictEqual(emitted(r, 'SEND', B).params.quantity, '999.999');
            assert.deepStrictEqual(reserves(), { a: '0.001', b: '0.001', shares: '0.001' });
        });

        it('partial removeLiquidity returns the right fraction', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
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

        // Output above 1e4 units puts one 8-dp base unit inside the tolerant gte band.
        it('enforces minOut to the base unit on a large swap', async function () {
            await deploy(); await addLiq(LP1, '1000000', '1000000');
            const out = emitted(await swap(T1, A, '100000', '0'), 'SEND', B).params.quantity;
            const over = math.format(math.add(bn(out), bn('0.00000001')), { notation: 'fixed' });
            await deploy(); await addLiq(LP1, '1000000', '1000000');
            assertReverted(await swap(T1, A, '100000', over), 'slippage');
            await deploy(); await addLiq(LP1, '1000000', '1000000');
            assertSuccess(await swap(T1, A, '100000', out));
        });

        it('a non-finite minOut still reverts', async function () {
            for (const bad of ['NaN', 'Infinity']) {
                await deploy(); await addLiq(LP1, '1000', '1000');
                assertReverted(await swap(T1, A, '100', bad), 'slippage');
            }
        });

        // Pins the documented COST of reverting on minOut (amm.js "CUSTODY MODEL",
        // README "A reverted call's DEPOSIT is not rolled back"). BATCH is not
        // all-or-nothing, so the deposit batched ahead of a reverting swap() settles
        // anyway and the delta accounting hands it to the NEXT trader. A future
        // change that refunds or credits it instead must rewrite this test together
        // with those doc entries, not delete it.
        it('a reverted swap strands its batched DEPOSIT, and the next trader inherits it', async function () {
            await deploy();
            await addLiq(LP1, '1000', '1000');
            assertReverted(await swap(T1, A, '100', '95'), 'slippage');
            assertContractBalance(h.ledger, ADDR, A, '1100');   // T1's 100 settled anyway
            assertContractState(h.ledger, ADDR, 'reserveA', '1000'); // reserves never saw it

            // LP2 deposits 100 and is priced on 200: T1's stranded input plus their own.
            const r = await swap(LP2, A, '100', '0');
            assertSuccess(r);
            assertContractState(h.ledger, ADDR, 'reserveA', '1200');
            // A lone 100-in trade on this pool cannot pay more than the no-fee bound
            // 1000 - 1000*1000/1100 = 90.909..., so a larger payout is T1's tokens.
            const out = emitted(r, 'SEND', B).params.quantity;
            assert.ok(math.larger(bn(out), bn('90.9091')), 'credited more than a 100-in trade could ever pay');
            assert.strictEqual(h.ledger.getBalance(T1, B), '100000000', 'T1 got nothing back');
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
        // banker's/half-even, pinned by xchain-indexer/test/unit/xchain_price.test.js).
        const norm = (v, d) => math.format(bn(v), { notation: 'fixed', precision: d });
        // Fractional-digit count; a value with <= d fraction digits sits on the tick grid,
        // so the indexer's write-time re-normalization is a numeric no-op.
        const fracLen = (v) => { const s = String(v); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
        const onGrid = (v, d) => fracLen(v) <= d;

        it('quantises totalShares to the LP grid so the last LP drains all but the locked minimum', async function () {
            await deploy();
            // sqrt(1000 * 3000) = 1732.05080756887... : off the 8-dp grid.
            const r1 = await addLiq(LP1, '1000', '3000');
            assertSuccess(r1);
            const mint1 = emitted(r1, 'SEND', LP).params.quantity;
            assert.ok(onGrid(reserves().shares, 8),
                'totalShares must sit on the 8-dp LP grid, got ' + reserves().shares);
            assert.ok(math.equal(bn(reserves().shares), math.add(bn(norm(mint1, 8)), bn('0.001'))),
                'state totalShares must equal the LP supply the indexer mints plus the locked minimum');

            // Second provider deposits in-ratio; the proportional share repeats.
            const r2 = await addLiq(LP2, '333', '999');
            assertSuccess(r2);
            const mint2 = emitted(r2, 'SEND', LP).params.quantity;
            assert.ok(onGrid(reserves().shares, 8), 'totalShares stays gridded after the 2nd add');
            assert.ok(math.equal(bn(reserves().shares), math.add(math.add(bn(norm(mint1, 8)), bn(norm(mint2, 8))), bn('0.001'))),
                'totalShares == sum of minted LP plus the locked minimum');

            // Both LPs redeem everything; the pool must drain to exactly zero. The bug
            // divided by an inflated totalShares, so the final dust was unwithdrawable.
            h.deposit(LP2, ADDR, LP, mint2);
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP2 }));
            assert.ok(onGrid(reserves().a, 8) && onGrid(reserves().b, 8), 'reserves gridded after partial exit');

            h.deposit(LP1, ADDR, LP, mint1);
            assertSuccess(await h.execute({ contractAddress: ADDR, method: 'removeLiquidity', params: [], caller: LP1 }));
            const left = reserves();
            assert.strictEqual(left.shares, '0.001', 'only the locked minimum remains');
            assert.ok(onGrid(left.a, 8) && onGrid(left.b, 8) && math.larger(bn(left.a), 0), 'last LP leaves only the locked slice behind');
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
