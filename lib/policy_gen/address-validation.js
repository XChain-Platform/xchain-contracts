// SPDX-License-Identifier: MIT

'use strict';

const crypto = require('crypto');

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

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
