// SPDX-License-Identifier: MIT

'use strict';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assert(cond, msg) {
    if (!cond) throw new Error('policy config: ' + msg);
}

module.exports = { isPlainObject, assert };
