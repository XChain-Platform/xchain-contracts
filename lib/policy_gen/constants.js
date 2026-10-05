// SPDX-License-Identifier: MIT

'use strict';

const ACTION_CLASSES = ['transfer', 'trade', 'burn', 'mint', 'stake', 'ownership'];
const BINDABLE_CLASSES = ACTION_CLASSES.concat(['all']);
const TRADE_ACTION_TYPES = ['ORDER_CREATE', 'SWAP_CREATE'];
const ALLOWLIST_DIRECTIONS = ['from', 'to', 'both'];
const MAX_BPS = 10000;
const PROTOCOL_MAX_TAKE_BPS = 10000;

const ADDR_RE = /^[A-Za-z0-9:_-]{1,120}$/;
const PERM_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const NAME_RE = /^[A-Za-z0-9 ._-]{1,60}$/;
const META_TEXT_RE = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/;
const META_NAME_MAX = 64;
const META_DESCRIPTION_MAX = 512;
const META_VERSION_MAX = 32;

module.exports = {
    ACTION_CLASSES,
    BINDABLE_CLASSES,
    TRADE_ACTION_TYPES,
    ALLOWLIST_DIRECTIONS,
    MAX_BPS,
    PROTOCOL_MAX_TAKE_BPS,
    ADDR_RE,
    PERM_RE,
    NAME_RE,
    META_TEXT_RE,
    META_NAME_MAX,
    META_DESCRIPTION_MAX,
    META_VERSION_MAX
};
