// SPDX-License-Identifier: MIT
//
// XChain Platform: Contract Template Library
// test/helpers/harness.js: in-process model of the contract API for property tests
//
// Copyright (c) 2026 Dankest, LLC. MIT License.
//
// Runs a template in a node:vm context against a small ledger model, so the
// invariant suites under */<name>_test/invariants.js run without the sibling
// xchain-vm checkout. It models the surface the templates call, as their own
// comments and READMEs document it:
//   - xchain.math: 64 significant digit BigNumber, every result a fixed
//     notation string; gt/gte/lt/lte/eq tolerant by max(1e-12 x larger, 1e-15).
//   - emissions are deferred: applied in order after the method returns, each
//     emitted quantity normalised half-up to the tick's decimals at write time;
//     a send or destroy beyond custody reverts the whole call.
//   - any throw reverts state, balances and emissions together.
//   - the sandbox replaces Date and Math.random with throwing stubs, so a
//     template that reads wall-clock time or randomness fails its suite.
//   - state.set/delete apply the VM StateManager rules with key NUL rejection
//     and key normalisation active: key size, value size, the per-contract key
//     count, and null/undefined/NaN/Infinity values. The caps default to the
//     VM's and `new Harness({ limits })` lowers them for a growth test.
// It is a model, not the VM: a finding taken from it is confirmed against the
// real VM before it is treated as consensus behaviour. mathjs is resolved from
// the sibling xchain-vm install, then from NODE_PATH; without it the suites skip.
// The model clock opens at MODEL_START_HEIGHT / MODEL_START_TIMESTAMP, below every
// armed block-time gate, and it has no network, gas metering, sandbox gating or
// exec re-lint, so a passing invariant suite says nothing about gate-keyed
// behaviour, which only a run on the real VM (E2EHarness) exercises.

'use strict';

const vm = require('vm');
const path = require('path');

let mathjs = null;
for (const p of [path.join(__dirname, '..', '..', '..', 'xchain-vm', 'node_modules', 'mathjs'), 'mathjs']) {
    try { mathjs = require(p); break; } catch (e) { /* try next */ }
}

const available = mathjs !== null;
const M = available ? mathjs.create(mathjs.all, { number: 'BigNumber', precision: 64 }) : null;

function bn(v) {
    if (v === null || v === undefined || v === '') throw new Error('math: empty operand');
    return M.bignumber(String(v));
}

function fixed(b) {
    if (!b.isFinite()) return b.isNaN() ? 'NaN' : (b.isNeg() ? '-Infinity' : 'Infinity');
    return b.toFixed();
}

function tolerantCompare(a, b) {
    const x = bn(a), y = bn(b);
    if (x.isNaN() || y.isNaN()) return NaN;
    if (!x.isFinite() || !y.isFinite()) return x.gt(y) ? 1 : (x.lt(y) ? -1 : 0);
    // Decimal methods compare exactly; mathjs max() would apply its own epsilon.
    const larger = x.abs().gte(y.abs()) ? x.abs() : y.abs();
    const rel = larger.times('1e-12');
    const floor = M.bignumber('1e-15');
    const band = rel.gte(floor) ? rel : floor;
    if (x.minus(y).abs().lte(band)) return 0;
    return x.gt(y) ? 1 : -1;
}

function makeMath() {
    return {
        add: (a, b) => fixed(bn(a).plus(bn(b))),
        subtract: (a, b) => fixed(bn(a).minus(bn(b))),
        multiply: (a, b) => fixed(bn(a).times(bn(b))),
        divide: (a, b) => fixed(bn(a).div(bn(b))),
        mod: (a, b) => fixed(bn(a).mod(bn(b))),
        min: (a, b) => fixed(bn(a).lte(bn(b)) ? bn(a) : bn(b)),
        max: (a, b) => fixed(bn(a).gte(bn(b)) ? bn(a) : bn(b)),
        sqrt: (a) => fixed(bn(a).sqrt()),
        floor: (a) => fixed(bn(a).floor()),
        abs: (a) => fixed(bn(a).abs()),
        gt: (a, b) => tolerantCompare(a, b) > 0,
        gte: (a, b) => tolerantCompare(a, b) >= 0,
        lt: (a, b) => tolerantCompare(a, b) < 0,
        lte: (a, b) => tolerantCompare(a, b) <= 0,
        eq: (a, b) => tolerantCompare(a, b) === 0,
        compare: (a, b) => tolerantCompare(a, b),
        isZero: (a) => bn(a).isZero()
    };
}

// Half-up normalisation of an emitted amount onto a tick's decimal grid.
function roundHalfUp(v, decimals) {
    return bn(v).toDecimalPlaces(decimals, M.BigNumber.ROUND_HALF_UP).toFixed();
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// VM state caps: maxStateKeys and maxStateValueSize as xchain-vm's limits_defaults.js
// resolves them, maxStateKeySize as xchain-vm's state.js falls back to it.
const STATE_LIMITS = { maxStateKeys: 10000, maxStateValueSize: 65536, maxStateKeySize: 1024 };

// Coerce a state key as the VM does once key normalisation is active.
function stateKey(key) {
    const t = typeof key;
    if (t === 'string') return key;
    if (t === 'number' || t === 'boolean') return String(key);
    throw new Error('state key must be a string, number, or boolean');
}

function checkKey(key, limits) {
    if (Buffer.byteLength(key, 'utf8') > limits.maxStateKeySize)
        throw new Error('state key exceeds max size (' + limits.maxStateKeySize + ' bytes)');
    if (key.indexOf('\u0000') !== -1) throw new Error('state key contains a NUL (0x00) byte');
}

// Mirror xchain-vm StateManager.set and delete over one contract's state map.
function makeState(st, limits) {
    const has = (k) => Object.prototype.hasOwnProperty.call(st, k);
    return {
        get: (k) => { k = stateKey(k); return has(k) ? clone(st[k]) : null; },
        set: (k, v) => {
            k = stateKey(k);
            checkKey(k, limits);
            if (v === null || v === undefined)
                throw new Error('state value cannot be null or undefined; use state.delete() to remove keys');
            if (typeof v === 'number' && !isFinite(v))
                throw new Error('state value cannot be NaN or Infinity; use xchain.math for numeric operations');
            const serialized = JSON.stringify(v);
            if (serialized === undefined) throw new Error('state value must be JSON-serializable');
            if (Buffer.byteLength(serialized, 'utf8') > limits.maxStateValueSize)
                throw new Error('state value exceeds max size (' + limits.maxStateValueSize + ' bytes)');
            if (!has(k) && Object.keys(st).length >= limits.maxStateKeys)
                throw new Error('contract exceeds max state keys (' + limits.maxStateKeys + ')');
            st[k] = JSON.parse(serialized);
        },
        delete: (k) => {
            k = stateKey(k);
            checkKey(k, limits);
            const live = has(k);
            delete st[k];
            return live;
        }
    };
}

function deny(name) {
    return function () { throw new Error('nondeterministic API used: ' + name); };
}

function loadContract(code) {
    const module = { exports: {} };
    const DateStub = function () { throw new Error('nondeterministic API used: Date'); };
    DateStub.now = deny('Date.now');
    const ctx = vm.createContext({ module: module, exports: module.exports, Date: DateStub });
    vm.runInContext('Math.random = function () { throw new Error("nondeterministic API used: Math.random"); };', ctx);
    vm.runInContext(code, ctx, { timeout: 5000 });
    return module.exports;
}

// Arbitrary model clock origin, deliberately earlier than every armed
// *_GATE_BLOCK_TIME in xchain-vm. Suites derive their times from these.
const MODEL_START_HEIGHT = 100;
const MODEL_START_TIMESTAMP = 1700000000;

class Ledger {
    constructor() {
        this.balances = {};        // addr -> tick -> string
        this.tokens = {};          // tick -> { DECIMALS, SUPPLY, MAX_SUPPLY, OWNER, LOCK_MINT, ... }
        this.state = {};           // contract -> key -> value
        this.blockHeight = MODEL_START_HEIGHT;
        this.blockTimestamp = MODEL_START_TIMESTAMP;
        this.blockHash = 'a'.repeat(64);
        this.oracle = { prices: {}, rounds: {}, snapshotAge: 0 };
        this.polls = {};
    }
    snapshot() {
        return clone({ balances: this.balances, tokens: this.tokens, state: this.state });
    }
    restore(s) { this.balances = s.balances; this.tokens = s.tokens; this.state = s.state; }
    decimals(tick) { return this.tokens[tick] ? this.tokens[tick].DECIMALS : 8; }
    setTokenDecimals(tick, d) {
        this.tokens[tick] = Object.assign(this.tokens[tick] || { SUPPLY: '0' }, { DECIMALS: d });
    }
    getBalance(addr, tick) {
        return (this.balances[addr] && this.balances[addr][tick] !== undefined) ? this.balances[addr][tick] : '0';
    }
    hasEntry(addr, tick) { return !!(this.balances[addr] && this.balances[addr][tick] !== undefined); }
    credit(addr, tick, q) {
        if (!this.tokens[tick]) this.tokens[tick] = { DECIMALS: 8, SUPPLY: '0' };
        this.balances[addr] = this.balances[addr] || {};
        this.balances[addr][tick] = fixed(bn(this.getBalance(addr, tick)).plus(bn(q)));
    }
    debit(addr, tick, q) {
        const next = bn(this.getBalance(addr, tick)).minus(bn(q));
        if (next.isNeg()) throw new Error('insufficient balance: ' + addr + ' ' + tick + ' has ' +
            this.getBalance(addr, tick) + ', needs ' + q);
        this.balances[addr] = this.balances[addr] || {};
        this.balances[addr][tick] = fixed(next);
    }
    // Sum of every holder's balance of a tick: the conservation probe.
    total(tick) {
        let t = bn('0');
        for (const a of Object.keys(this.balances)) if (this.balances[a][tick] !== undefined) t = t.plus(bn(this.balances[a][tick]));
        return fixed(t);
    }
}

class Harness {
    constructor(opts) {
        this.ledger = new Ledger();
        this.contracts = {};
        this.log = [];
        this.limits = Object.assign({}, STATE_LIMITS, opts && opts.limits);
    }
    seedBalance(addr, tick, q) { this.ledger.credit(addr, tick, q); }
    // DEPOSIT: an atomic transfer into contract custody ahead of an EXECUTE.
    deposit(from, to, tick, q) { this.ledger.debit(from, tick, q); this.ledger.credit(to, tick, q); }
    mineBlock(n, secondsPerBlock) {
        const k = n === undefined ? 1 : n;
        this.ledger.blockHeight += k;
        this.ledger.blockTimestamp += k * (secondsPerBlock === undefined ? 600 : secondsPerBlock);
    }
    deploy(opts) {
        const exp = loadContract(opts.code);
        this.contracts[opts.contractAddress] = { exports: exp, deployer: opts.deployer };
        this.ledger.state[opts.contractAddress] = this.ledger.state[opts.contractAddress] || {};
        if (typeof exp.initialize !== 'function') return { success: true, actions: [] };
        return this.run(opts.contractAddress, 'initialize', opts.params || [], opts.deployer);
    }
    execute(opts) {
        return this.run(opts.contractAddress, opts.method, opts.params || [], opts.caller);
    }
    state(addr, key) {
        const v = this.ledger.state[addr][key];
        return v === undefined ? null : v;
    }
    run(addr, method, params, caller) {
        const c = this.contracts[addr];
        if (!c) return { success: false, error: 'no contract at ' + addr, actions: [] };
        const fn = c.exports[method];
        if (typeof fn !== 'function' || method === 'meta' || method === 'abi')
            return { success: false, error: 'no method ' + method, actions: [] };
        const snap = this.ledger.snapshot();
        const actions = [];
        const xchain = this.makeApi(addr, params, caller, actions);
        try {
            const result = fn.call(c.exports, xchain);
            this.applyActions(addr, actions);
            return { success: true, result: result, actions: actions };
        } catch (e) {
            this.ledger.restore(snap);
            return { success: false, error: String(e && e.message || e), actions: [] };
        }
    }
    applyActions(addr, actions) {
        const L = this.ledger;
        for (const a of actions) {
            const p = a.params;
            if (a.action === 'SEND') {
                const q = roundHalfUp(p.quantity, L.decimals(p.tick));
                if (!bn(q).gt(0)) throw new Error('SEND quantity must be positive: ' + p.quantity);
                L.debit(addr, p.tick, q);
                L.credit(p.destination, p.tick, q);
                a.settled = q;
            } else if (a.action === 'ISSUE') {
                if (L.tokens[p.tick] && L.tokens[p.tick].OWNER) throw new Error('tick already issued: ' + p.tick);
                const d = p.decimals !== undefined ? parseInt(p.decimals, 10) : 8;
                L.tokens[p.tick] = { DECIMALS: d, SUPPLY: '0', OWNER: addr,
                    MAX_SUPPLY: p.maxSupply || '0', LOCK_MINT: p.lockMint === '1' };
                if (p.mintSupply && bn(p.mintSupply).gt(0)) {
                    const q = roundHalfUp(p.mintSupply, d);
                    L.tokens[p.tick].SUPPLY = q;
                    L.credit(addr, p.tick, q);
                }
            } else if (a.action === 'MINT') {
                const t = L.tokens[p.tick];
                if (!t || t.OWNER !== addr) throw new Error('MINT by non-owner: ' + p.tick);
                const q = roundHalfUp(p.quantity, t.DECIMALS);
                const next = bn(t.SUPPLY).plus(bn(q));
                if (t.MAX_SUPPLY && bn(t.MAX_SUPPLY).gt(0) && next.gt(bn(t.MAX_SUPPLY))) throw new Error('MINT beyond max supply');
                t.SUPPLY = fixed(next);
                L.credit(addr, p.tick, q);
            } else if (a.action === 'DESTROY') {
                const q = roundHalfUp(p.quantity, L.decimals(p.tick));
                L.debit(addr, p.tick, q);
                if (L.tokens[p.tick]) L.tokens[p.tick].SUPPLY = fixed(bn(L.tokens[p.tick].SUPPLY).minus(bn(q)));
            } else {
                throw new Error('harness: unmodelled action ' + a.action);
            }
        }
    }
    makeApi(addr, params, caller, actions) {
        const L = this.ledger;
        const st = L.state[addr];
        const self = this;
        const push = (action) => (p) => { actions.push({ action: action, params: clone(p) }); };
        return {
            require: (cond, msg) => { if (!cond) throw new Error(msg || 'require failed'); },
            getInputParam: (i) => (i < params.length ? params[i] : null),
            getInputParamCount: () => params.length,
            getSourceAddress: () => caller,
            getContractAddress: () => addr,
            getBlockHeight: () => L.blockHeight,
            getBlockTimestamp: () => L.blockTimestamp,
            getBlockHash: () => L.blockHash,
            getBalance: (a, tick) => L.getBalance(a, tick),
            getTokenInfo: (tick) => (L.tokens[tick] && L.hasEntry(addr, tick)) ? clone(L.tokens[tick]) : null,
            getPollResult: (id) => (L.polls[id] === undefined ? null : clone(L.polls[id])),
            log: (m) => { self.log.push(m); },
            math: makeMath(),
            state: makeState(st, self.limits),
            emit: {
                send: push('SEND'), issue: push('ISSUE'), mint: push('MINT'), destroy: push('DESTROY')
            },
            oracle: {
                getPrice: (pair) => (L.oracle.prices[pair] === undefined ? null : clone(L.oracle.prices[pair])),
                getPriceAtRound: (pair, r) => {
                    const m = L.oracle.rounds[pair] || {};
                    return m[r] === undefined ? null : clone(m[r]);
                },
                getSnapshotAge: () => L.oracle.snapshotAge
            }
        };
    }
}

// Small deterministic PRNG (mulberry32) for seeded property tests.
function rng(seed) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return {
        next: next,
        int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
        pick: (arr) => arr[Math.floor(next() * arr.length)]
    };
}

module.exports = {
    available, Harness, loadContract, rng, M, bn, fixed, roundHalfUp, STATE_LIMITS,
    MODEL_START_HEIGHT, MODEL_START_TIMESTAMP
};
