'use strict';

module.exports = function registerProposalGatingTests(context) {
    const { assertReverted, HOLDER, ATTACKER, PAYEE, PAY, deploy, propose, call } = context;

    describe('proposal gating', function () {
        it('an address without governance holdings cannot propose', async function () {
            await deploy();
            assertReverted(await propose(ATTACKER), 'insufficient governance holdings');
        });

        it('a zero amount cannot be proposed', async function () {
            await deploy();
            assertReverted(await call('propose', [PAYEE, PAY, '0', ''], HOLDER), 'amount must be positive');
        });
    });
};
