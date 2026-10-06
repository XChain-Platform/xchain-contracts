'use strict';

module.exports = function registerEmptyTokenInfoTests(ctx) {
    const {
        assert, XChainVM, E2EHarness, CODE, ALICE, ADDR, COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE,
        assertSuccess, assertBalance, assertContractState, setPrice, depositColl, borrow
    } = ctx;

    // The stable's decimal grid, under PRODUCTION reachability.
    //
    // On a fresh deployment no balance row holds the stable, so
    // getTokenInfo(stableTick) is null on a real node. These deploys seed only
    // the collateral, so the grid must come from state, declared on the same
    // emit.issue that creates the token.
    describe('the stable grid survives an empty tokenInfo snapshot', function () {
        async function deployNoStableInfo(params) {
            ctx.h = new E2EHarness(XChainVM);
            ctx.h.seedBalance(ALICE, 'XCHAIN', '1000000');
            ctx.h.seedBalance(ALICE, COLL, '100');
            ctx.h.ledger.setTokenDecimals(COLL, 8);
            return ctx.h.deploy({
                code: CODE, deployer: ALICE, contractAddress: ADDR,
                params: params || [COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE]
            });
        }

        it('borrows with no stable entry in the snapshot, flooring on the declared grid', async function () {
            assertSuccess(await deployNoStableInfo());
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            assertSuccess(await borrow(ALICE, '0.000000015'),
                'borrow must not depend on getTokenInfo(stableTick)');
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '0.00000001');
            assertBalance(ctx.h.ledger, ALICE, STABLE, '0.00000001');
        });

        it('declares the grid on the issuance and floors borrow onto it', async function () {
            const r = await deployNoStableInfo([COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE, '2']);
            assertSuccess(r);
            assertContractState(ctx.h.ledger, ADDR, 'stableDecimals', '2');
            const issue = r.result.emittedActions.find(e => e.action === 'ISSUE');
            assert.strictEqual(issue.params.decimals, '2',
                'the ISSUE must carry the grid borrow() floors against');
            setPrice('100');
            assertSuccess(await depositColl(ALICE, '3'));
            assertSuccess(await borrow(ALICE, '1.239'));
            assertContractState(ctx.h.ledger, ADDR, 'totalDebt', '1.23');
            assertBalance(ctx.h.ledger, ALICE, STABLE, '1.23');
        });

        it('an omitted stableDecimals defaults to 8 and is declared as such', async function () {
            const r = await deployNoStableInfo();
            assertSuccess(r);
            assertContractState(ctx.h.ledger, ADDR, 'stableDecimals', '8');
            const issue = r.result.emittedActions.find(e => e.action === 'ISSUE');
            assert.strictEqual(issue.params.decimals, '8');
        });

        // Same integer-shape gate as maxSnapshotAge: the raw text lands in state
        // and on a supply-locked ISSUE, so a parseInt-blessed spelling would
        // desync the two.
        it('rejects a stableDecimals a radix-less parseInt would silently re-measure', async function () {
            const BAD = ['1e1', '0x10', '7abc', ' 7', '8.5', '1_000', '+8', '-1', '19', 'abc', 'NaN'];
            for (const v of BAD) {
                assert.strictEqual(
                    (await deployNoStableInfo([COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE, v])).success,
                    false, `stableDecimals ${JSON.stringify(v)} must not deploy`);
            }
            assert.strictEqual(
                (await deployNoStableInfo([COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE, '0'])).success, true);
            assert.strictEqual(
                (await deployNoStableInfo([COLL, STABLE, PAIR, RATIO, BONUS, MAXAGE, '18'])).success, true);
        });
    });
};
