// SPDX-License-Identifier: MIT
//
// Copyright (c) 2026 Dankest, LLC
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND. See the MIT License for the full text.

'use strict';

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function assert(cond, msg) {
    if (!cond) throw new Error('policy config: ' + msg);
}

module.exports = { isPlainObject, assert };
