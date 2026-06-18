#!/usr/bin/env node
// SPDX-License-Identifier: MIT
//
// xchain-contracts: the contract authoring front door.
//
//   xchain-contracts scaffold <name> [outfile]   print or write a template/pattern source
//   xchain-contracts lint [files…] [--json]       lint sources (default: all templates + patterns)
//   xchain-contracts list                         list available templates and patterns
//
// `lint` delegates to xchain-vm's authoritative linter (the full validateSyntax,
// incl. the isolated-vm V8 step (requires Node 22). `scaffold` / `list` are
// pure file reads and run anywhere.

'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');   // the xchain-contracts package root

// Templates are <name>/<name>.js; patterns are patterns/<name>.js (minus *.test.js).
function listAvailable() {
    const templates = [];
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== 'patterns' && e.name !== 'node_modules' && e.name !== 'bin'
            && fs.existsSync(path.join(ROOT, e.name, e.name + '.js')))
            templates.push(e.name);
    }
    const patterns = [];
    const pdir = path.join(ROOT, 'patterns');
    if (fs.existsSync(pdir))
        for (const f of fs.readdirSync(pdir).sort())
            if (f.endsWith('.js') && !f.endsWith('.test.js')) patterns.push(f.replace(/\.js$/, ''));
    return { templates: templates.sort(), patterns };
}

function sourcePath(name) {
    const tpl = path.join(ROOT, name, name + '.js');
    if (fs.existsSync(tpl)) return tpl;
    const pat = path.join(ROOT, 'patterns', name + '.js');
    if (fs.existsSync(pat)) return pat;
    return null;
}

function cmdList() {
    const a = listAvailable();
    process.stdout.write('templates:\n  ' + a.templates.join('\n  ') + '\n');
    process.stdout.write('patterns:\n  ' + a.patterns.join('\n  ') + '\n');
}

function cmdScaffold(args) {
    const name = args[0];
    const outfile = args[1];
    if (!name) {
        process.stderr.write('usage: xchain-contracts scaffold <name> [outfile]\n');
        process.exit(2);
    }
    const src = sourcePath(name);
    if (!src) {
        const a = listAvailable();
        process.stderr.write('unknown template/pattern: "' + name + '"\n');
        process.stderr.write('  templates: ' + a.templates.join(', ') + '\n');
        process.stderr.write('  patterns:  ' + a.patterns.join(', ') + '\n');
        process.exit(2);
    }
    const code = fs.readFileSync(src, 'utf8');
    if (outfile) {
        fs.writeFileSync(outfile, code);
        process.stderr.write('wrote ' + outfile + ' (' + name + ')\n');
    } else {
        process.stdout.write(code);
    }
}

function cmdLint(args) {
    // Resolve xchain-vm's lint CLI; fall back to the monorepo sibling path so this
    // works without an `npm install` (which would rebuild isolated-vm).
    let lintPath;
    try { lintPath = require.resolve('xchain-vm/bin/lint.js'); }
    catch (e) { lintPath = path.join(ROOT, '..', 'xchain-vm', 'bin', 'lint.js'); }

    // With no files (or only flags), lint the library's own sources.
    const onlyFlags = args.every((a) => a.startsWith('-'));
    let files = args.slice();
    if (onlyFlags) {
        const a = listAvailable();
        files = files.concat(
            a.templates.map((t) => path.join(ROOT, t, t + '.js')),
            a.patterns.map((p) => path.join(ROOT, 'patterns', p + '.js'))
        );
    }

    // bin/lint.js reads process.argv.slice(2) and calls process.exit() itself.
    process.argv = [process.argv[0], lintPath].concat(files);
    require(lintPath);
}

function usage() {
    process.stdout.write(
        'usage: xchain-contracts <command>\n\n' +
        '  scaffold <name> [outfile]   print a template/pattern source, or write it to outfile\n' +
        '  lint [files…] [--json]      lint sources (default: all templates + patterns; needs Node 22)\n' +
        '  list                        list available templates and patterns\n'
    );
}

function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const rest = argv.slice(1);
    switch (cmd) {
        case 'list':     return cmdList();
        case 'scaffold': return cmdScaffold(rest);
        case 'lint':     return cmdLint(rest);
        case undefined:
        case '-h':
        case '--help':   return usage();
        default:
            process.stderr.write('unknown command: "' + cmd + '"\n');
            usage();
            process.exit(2);
    }
}

main();
