// SPDX-License-Identifier: MIT

'use strict';

module.exports = function registerDeadHelperDetection(deps) {
    const { assert, generatePolicy, MATRIX } = deps;

    function unreadDeclarations(source) {
        const uses = (re) => (source.match(re) || []).length;
        const fns = [...source.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]);
        const vars = [...source.matchAll(/^var\s+([A-Za-z_$][\w$]*)\s*=/gm)].map(m => m[1]);
        return fns.filter(n => uses(new RegExp('(?<![\\w$])' + n + '\\s*\\(', 'g')) < 2)
            .concat(vars.filter(n => uses(new RegExp('(?<![\\w$])' + n + '(?![\\w$])', 'g')) < 2));
    }

    describe('policy-gen: generated source carries no dead helpers', function () {
        for (const key of Object.keys(MATRIX)) {
            it(key + ' declares only helpers and constants its methods read', function () {
                assert.deepStrictEqual(unreadDeclarations(generatePolicy(MATRIX[key]).source), [], key);
            });
        }

        it('keeps every helper where its caller exists', function () {
            const full = generatePolicy(MATRIX.full).source;
            for (const n of ['function actionType(', 'function argAddr(', 'function requireAddrArg(', 'function onlyOwner(', 'var OWNER'])
                assert.ok(full.indexOf(n) !== -1, 'full lost ' + n);
        });
    });
};
