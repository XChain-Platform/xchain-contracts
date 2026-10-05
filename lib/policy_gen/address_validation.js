// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND. See the MIT License for the full text.

'use strict';

// Node-side only: this module is the CLI generator, never contract source.
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Royalty payout-leg address gate.
//
// ADDR_RE above is a charset filter for strings embedded into the generated
// source, not an address validator, and a royalty recipient is the one config
// value the CHAIN re-validates at guard time: the indexer checks every returned
// leg with a full base58check / bech32 decode and fails closed on the WHOLE
// action, so a typo, a placeholder, or a contract ledger address ('C:BTC:123')
// generates, deploys and binds cleanly and then denies every ORDER_CREATE and
// SWAP_CREATE for the token. That is the same "the no-code path must not emit a
// guard consensus refuses" rule the meta gate below states for deploy time.
//
// INVARIANT, and the whole safety argument for this gate: it is deliberately
// NETWORK-AGNOSTIC. Any base58check version byte and any bech32 HRP is accepted,
// while the chain additionally pins those to the configured coin and network.
// This gate is therefore a strict SUPERSET of the chain rule: it can never
// reject an address the runtime would have accepted, only catch one it would
// have refused. Keep it that way - never add a version-byte or HRP allowlist
// here, because the generator does not know which chain the token lives on.
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

// Decode base58 to bytes, big-endian, preserving leading zero bytes. Returns
// null on any character outside the alphabet.
function base58Decode(str) {
    const bytes = [0];
    for (let i = 0; i < str.length; i++) {
        const v = B58_ALPHABET.indexOf(str.charAt(i));
        if (v < 0) return null;
        let carry = v;
        for (let j = 0; j < bytes.length; j++) {
            carry += bytes[j] * 58;
            bytes[j] = carry & 0xff;
            carry = carry >> 8;
        }
        while (carry > 0) { bytes.push(carry & 0xff); carry = carry >> 8; }
    }
    for (let i = 0; i < str.length && str.charAt(i) === '1'; i++) bytes.push(0);
    return Buffer.from(bytes.reverse());
}

// A P2PKH/P2SH address: base58check whose payload is one version byte plus a
// 20-byte hash160, with a double-SHA256 checksum.
function isBase58CheckAddress(str) {
    const buf = base58Decode(str);
    if (!buf || buf.length !== 25) return false;
    const payload = buf.subarray(0, 21);
    const want = crypto.createHash('sha256')
        .update(crypto.createHash('sha256').update(payload).digest())
        .digest().subarray(0, 4);
    return want.equals(buf.subarray(21));
}

function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (let i = 0; i < values.length; i++) {
        const top = chk >>> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ values[i];
        for (let j = 0; j < 5; j++) if ((top >>> j) & 1) chk ^= GEN[j];
    }
    return chk >>> 0;
}

// A segwit address: BIP173 bech32 or BIP350 bech32m. Either checksum constant is
// accepted, since witness version 0 and versions 1+ use different ones.
function isBech32Address(str) {
    if (str.length < 8 || str.length > 90) return false;
    if (str !== str.toLowerCase() && str !== str.toUpperCase()) return false;
    const s = str.toLowerCase();
    const sep = s.lastIndexOf('1');
    if (sep < 1 || sep + 7 > s.length) return false;
    const hrp = s.substring(0, sep);
    const expanded = [];
    for (let i = 0; i < hrp.length; i++) {
        const c = hrp.charCodeAt(i);
        if (c < 33 || c > 126) return false;
        expanded.push(c >>> 5);
    }
    expanded.push(0);
    for (let i = 0; i < hrp.length; i++) expanded.push(hrp.charCodeAt(i) & 31);
    for (let i = sep + 1; i < s.length; i++) {
        const v = BECH32_CHARSET.indexOf(s.charAt(i));
        if (v < 0) return false;
        expanded.push(v);
    }
    const chk = bech32Polymod(expanded);
    return chk === 1 || chk === 0x2bc830a3;
}

function isPayoutAddress(str) {
    return isBase58CheckAddress(str) || isBech32Address(str);
}

module.exports = { isPayoutAddress };
