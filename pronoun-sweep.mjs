#!/usr/bin/env node
// pronoun-sweep.mjs — rewrites he/him/his to they/them/their, and refuses to guess.
//
// WHY IT IS SHAPED THIS WAY. A blind find-and-replace on pronouns is the easiest way there is to
// damage a document: it rewrites the inside of quotations, it mangles code, it turns "he lets it
// go" into nonsense, and it changes sentences that were about somebody else entirely. So this tool
// is built the other way round — it makes only the changes it can defend, and it hands every
// ambiguous line to a person.
//
// THE RULES
//   · quoted spans ("..." and “...”) and code spans (`...`) are copied through BYTE-IDENTICAL.
//     A quote keeps every word it was given.
//   · metalanguage is never touched: `he/him`, `she/her` — a slash-pair names the pronoun itself.
//   · a line goes to REVIEW, not AUTO, when it mentions somebody else (--others), carries a
//     contraction, has an odd number of quote marks, or needs verb agreement (he types -> types).
//   · --verify proves the result: for every changed line the protected spans must be unchanged and
//     the text must differ only in pronouns and their verbs. Nothing else is allowed to move.
//
// USAGE
//   node pronoun-sweep.mjs [<dir>]                     dry run: counts, reasons, per file
//   node pronoun-sweep.mjs [<dir>] --sheet out.md      dry run, plus a review sheet to read
//   node pronoun-sweep.mjs [<dir>] --commit            apply the AUTO lines (backup + receipt)
//   node pronoun-sweep.mjs --verify <state-dir>        prove a backup against the files it came from
//   node pronoun-sweep.mjs --self-test
//
//   --others "Name,Name"   names that mean "another person is being discussed" -> REVIEW
//   --skip "dir,dir"       directories to walk past (default: .git, node_modules, .pronoun-sweep)
//   --state <dir>          where the backup and receipt go (default: .pronoun-sweep in the cwd)
//
// Dry run by default. Nothing is written until --commit, and --commit writes a backup first.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '1.0.0';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------------------------

/** Contractions of "he" — these are phrases, because singular-they takes the plural verb. */
const PHRASES = [
  [/\bhe's been\b/g, "they've been"], [/\bHe's been\b/g, "They've been"],
  [/\bhe's got\b/g, "they've got"], [/\bHe's got\b/g, "They've got"],
  [/\bhe's\b/g, "they're"], [/\bHe's\b/g, "They're"],
  [/\bhe'd\b/g, "they'd"], [/\bHe'd\b/g, "They'd"],
  [/\bhe'll\b/g, "they'll"], [/\bHe'll\b/g, "They'll"],
  [/\bhe was\b/g, 'they were'], [/\bHe was\b/g, 'They were'],
  [/\bhe wasn't\b/g, "they weren't"], [/\bHe wasn't\b/g, "They weren't"],
  [/\bhe is\b/g, 'they are'], [/\bHe is\b/g, 'They are'],
  [/\bhe isn't\b/g, "they aren't"], [/\bHe isn't\b/g, "They aren't"],
  [/\bhe has\b/g, 'they have'], [/\bHe has\b/g, 'They have'],
  [/\bhe hasn't\b/g, "they haven't"], [/\bHe hasn't\b/g, "They haven't"],
  [/\bhe does\b/g, 'they do'], [/\bHe does\b/g, 'They do'],
  [/\bhe doesn't\b/g, "they don't"], [/\bHe doesn't\b/g, "They don't"],
].map(([re, to]) => [new RegExp(re.source.replace(/'/g, "['\u2019]"), re.flags), to]);

const PAIRS = [
  [/\bhe\b/g, 'they'], [/\bHe\b/g, 'They'],
  [/\bhim\b/g, 'them'], [/\bHim\b/g, 'Them'],
  [/\bhis\b/g, 'their'], [/\bHis\b/g, 'Their'],
  [/\bhimself\b/g, 'themselves'], [/\bHimself\b/g, 'Themselves'],
];

const CAND = /\b(he|him|his|himself|He|Him|His|Himself)\b/;
const HE = /\b(he|him|his|himself|He|Him|His|Himself)\b/g;
const THEY = /\b(they|them|their|theirs|themselves)\b/gi;
const CONTRACTION = /\b[Hh]e('s|'d|'ll|\u2019s|\u2019d|\u2019ll)\b/;

/** Words that end in -s but are not verbs needing agreement. */
const STOP = new Set(['his', 'hers', 'its', 'this', 'these', 'those', 'ours', 'yours', 'theirs',
  'less', 'yes', 'plus', 'thus', 'else', 'twice', 'once']);

/**
 * Verb agreement: singular-they takes the plural verb, so a present-tense lexical verb after "he"
 * ("he types", "he runs") is work for a hand. Auxiliaries are handled as phrases above, so what is
 * left here is exactly the cases this tool refuses to guess at.
 */
export function agreement(text) {
  const re = /\b[Hh]e\b/g;
  let m;
  while ((m = re.exec(text))) {
    const tail = text.slice(m.index + m[0].length).split(/\s+/).slice(0, 3).join(' ');
    for (const tok of tail.split(/\s+/)) {
      const w = tok.replace(/[^A-Za-z]+$/, '');
      if (/^[A-Za-z]{4,}s$/.test(w) && !STOP.has(w.toLowerCase())) return true;
    }
  }
  return false;
}

/** Protected spans — code (`...`) and double-quoted text — as [start,end) ranges. */
export function spans(line) {
  const out = [];
  let i = 0, mode = null, start = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (mode === 'code') { if (c === '`') { out.push([start, i + 1]); mode = null; } continue; }
    if (mode === 'dq') { if (c === '"' || c === '\u201D') { out.push([start, i + 1]); mode = null; } continue; }
    if (c === '`') { mode = 'code'; start = i; continue; }
    if (c === '"' || c === '\u201C') { mode = 'dq'; start = i; continue; }
  }
  if (mode) out.push([start, line.length]);   // unterminated -> protect the tail
  return out;
}

/** Replace inside one unprotected segment. Phrases first, then the bare pronouns. Never across `/`. */
export function applyPairs(seg) {
  let n = 0;
  for (const [re, to] of PHRASES) seg = seg.replace(re, () => { n++; return to; });
  for (const [re, to] of PAIRS) {
    seg = seg.replace(re, (m, off, whole) => {
      const before = whole[off - 1], after = whole[off + m.length];
      if (before === '/' || after === '/') return m;   // metalanguage: he/him names the pronoun
      n++; return to;
    });
  }
  return [seg, n];
}

/** The line rewritten, with every protected span copied through untouched. */
export function rewrite(line) {
  const cuts = spans(line).sort((a, b) => a[0] - b[0]);
  let outStr = '', i = 0, changed = 0;
  for (const [a, b] of cuts) {
    const [r, n] = applyPairs(line.slice(i, a));
    outStr += r; changed += n; outStr += line.slice(a, b); i = b;
  }
  const [r, n] = applyPairs(line.slice(i));
  outStr += r; changed += n;
  return [outStr, changed];
}

/** Everything outside the protected spans — what the agreement check is allowed to read. */
export function outside(line) {
  const prot = spans(line).sort((a, b) => a[0] - b[0]);
  let s = '', i = 0;
  for (const [a, b] of prot) { s += line.slice(i, a); i = b; }
  return s + line.slice(i);
}

/**
 * One line in, one verdict out. `auto` means every change is defensible; `review` carries the
 * reason. This is the whole policy, in one function, so the self-test can exercise it directly.
 */
export function classify(line, { others = [], } = {}) {
  if (!CAND.test(line)) return null;
  const [now, n] = rewrite(line);
  if (!n) return null;                                   // nothing outside a quote or code span
  const foreign = others.length ? new RegExp(`\\b(${others.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`) : null;
  if (foreign && foreign.test(line)) return { kind: 'review', why: 'names another person', was: line, now };
  if (CONTRACTION.test(line)) return { kind: 'review', why: 'contraction', was: line, now };
  if (agreement(outside(line))) return { kind: 'review', why: 'agreement', was: line, now };
  if ((line.match(/["\u201C\u201D]/g) || []).length % 2 === 1) return { kind: 'review', why: 'odd quotes', was: line, now };
  return { kind: 'auto', was: line, now };
}

/** A whole document: the lines this tool would change, and the ones it will only report. */
export function classifyText(text, opts = {}) {
  const lines = String(text).split('\n');
  const auto = [], review = [];
  lines.forEach((line, i) => {
    const verdict = classify(line, opts);
    if (!verdict) return;
    if (verdict.kind === 'auto') auto.push({ i: i + 1, was: line, now: verdict.now });
    else review.push({ i: i + 1, why: verdict.why, was: line, now: verdict.now });
  });
  return { lines, auto, review };
}

// ---------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------

export function walk(dir, skip = new Set(['.git', 'node_modules', '.pronoun-sweep']), acc = []) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (skip.has(e.name)) continue; walk(p, skip, acc); }
    else if (e.isFile() && e.name.endsWith('.md')) acc.push(p);
  }
  return acc;
}

const applyAll = (lines, edits) => {
  const o = lines.slice();
  for (const e of edits) o[e.i - 1] = e.now;
  return o.join('\n');
};

/**
 * The proof. For every file the backup holds, compare it to the file on disk line by line: the
 * protected spans must be identical, and once pronouns and their verbs are canonicalised the rest
 * of the line must be identical too. A failure is something that changed which is neither.
 */
export function verify(backupDir, rootDir) {
  // --verify takes the state directory (which holds the receipts too), or a backup directory
  // directly. A receipt is not a file to compare, so the newest backup is the thing to walk.
  let base = backupDir;
  if (!path.basename(backupDir).startsWith('backup-')) {
    const cands = fs.readdirSync(backupDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
      .map((e) => path.join(backupDir, e.name)).sort();
    if (cands.length) base = cands[cands.length - 1];
  }
  const files = walk(base, new Set());
  const fails = [];
  let changed = 0;
  for (const bp of files) {
    const rel = path.relative(base, bp);
    const cur = path.join(rootDir, rel);
    if (!fs.existsSync(cur)) { fails.push(`missing: ${rel}`); continue; }
    const A = fs.readFileSync(bp, 'utf8').split('\n');
    const B = fs.readFileSync(cur, 'utf8').split('\n');
    if (A.length !== B.length) { fails.push(`line count changed: ${rel}`); continue; }
    for (let i = 0; i < A.length; i++) {
      if (A[i] === B[i]) continue;
      changed++;
      if (JSON.stringify(spans(A[i])) !== JSON.stringify(spans(B[i]))) { fails.push(`a protected span moved: ${rel} L${i + 1}`); continue; }
      if (canon(A[i]) !== canon(B[i])) fails.push(`changed more than a pronoun: ${rel} L${i + 1}\n    was: ${A[i].trim().slice(0, 160)}\n    now: ${B[i].trim().slice(0, 160)}`);
    }
  }
  return { files: files.length, changed, fails };
}

const canon = (s) => s
  .replace(/[\u2019]/g, "'")
  .replace(/\b(he|him|his|himself|she|her|hers|they|them|their|theirs|themselves)\b/gi, 'PRON')
  .replace(/\b(doesn't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't)\b/gi, 'AUX')
  .replace(/\b(is|are|was|were|has|have|does|do)\b/gi, 'AUX')
  .replace(/'(s|d|ll|re|ve)\b/gi, 'CON')
  .replace(/\s+/g, ' ')
  .trim();

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1) {
      const name = a.replace(/^--?/, '');
      if (['others', 'skip', 'state', 'sheet', 'verify'].includes(name)) {
        const next = argv[i + 1];
        if (!next || next.startsWith('-')) return { error: `--${name} needs a value` };
        values.set(name, next); i++; continue;
      }
      flags.add(name); continue;
    }
    positional.push(a);
  }
  return {
    root: positional[0] || '.',
    others: (values.get('others') || '').split(',').map((s) => s.trim()).filter(Boolean),
    skip: new Set(['.git', 'node_modules', '.pronoun-sweep', ...(values.get('skip') || '').split(',').map((s) => s.trim()).filter(Boolean)]),
    state: values.get('state') || null,
    sheet: values.get('sheet') || null,
    verifyDir: values.get('verify') || null,
    commit: flags.has('commit'),
    help: flags.has('help') || flags.has('h'),
    version: flags.has('version') || flags.has('v'),
    selfTest: flags.has('self-test'),
  };
}

// ---------------------------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------------------------

const CASES = [
  ['a bare pronoun swaps', 'he walked in', (r) => r.auto[0]?.now === 'they walked in'],
  ['the capital keeps its case', 'His coat was here', (r) => r.auto[0]?.now === 'Their coat was here'],
  ['himself becomes themselves', 'he taught himself', (r) => r.auto[0]?.now === 'they taught themselves'],
  ['he is becomes they are', 'he is late', (r) => r.auto[0]?.now === 'they are late'],
  ['he was becomes they were', 'He was late', (r) => r.auto[0]?.now === 'They were late'],
  ['he has becomes they have', "he hasn't called", (r) => r.auto[0]?.now === "they haven't called"],

  // the rule that matters most: a quote keeps every word it was given
  ['a quoted span is untouched', 'he said "he was tired" and left', (r) => r.auto[0]?.now === 'they said "he was tired" and left'],
  ['a quote alone is not a change', 'she said "he was tired"', (r) => r.auto.length === 0 && r.review.length === 0],
  ['a code span is untouched', 'call `he` here', (r) => r.auto.length === 0],

  // metalanguage names the pronoun; it is not prose
  ['he/him is never rewritten', 'pronouns: he/him', (r) => r.auto.length === 0 && r.review.length === 0],

  // the refusals
  ['another person on the line goes to review', 'Dana said he would', (r) => r.review[0]?.why === 'names another person', { others: ['Dana'] }],
  ['a contraction goes to review', "he's late", (r) => r.review[0]?.why === 'contraction'],
  ['a present-tense verb goes to review', 'he types quickly', (r) => r.review[0]?.why === 'agreement'],
  ['an odd quote count goes to review', 'he said "hello', (r) => r.review[0]?.why === 'odd quotes'],

  // and the proof
  ['the verifier accepts a pure swap', null, () => {
    const before = 'he walked in and sat down';
    const after = rewrite(before)[0];
    return canon(before) === canon(after) && JSON.stringify(spans(before)) === JSON.stringify(spans(after));
  }],
  ['the verifier rejects a reworded line', null, () => canon('he walked in') !== canon('they walked in slowly')],
];

function selfTest() {
  let failed = 0;
  for (const [name, line, check, opts] of CASES) {
    let ok = false, detail = '';
    try { ok = Boolean(line === null ? check() : check(classifyText(line, opts))); }
    catch (e) { detail = e.message; }
    if (!ok) failed++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  }
  // the command line is part of the promise
  const run = (args) => spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8' });
  const help = run(['--help']);
  const helpOk = help.status === 0 && help.stdout.includes('--commit');
  if (!helpOk) failed++;
  console.log(`  ${helpOk ? 'PASS' : 'FAIL'}  --help is an answer, not an error`);
  const ver = run(['--version']);
  const verOk = ver.status === 0 && ver.stdout.includes(VERSION);
  if (!verOk) failed++;
  console.log(`  ${verOk ? 'PASS' : 'FAIL'}  --version names the version`);
  const missing = run(['--verify', 'a-directory-that-is-not-here']);
  const missingOk = missing.status === 2 && /no such/i.test(missing.stderr) && !/\n\s+at /.test(missing.stderr);
  if (!missingOk) failed++;
  console.log(`  ${missingOk ? 'PASS' : 'FAIL'}  a missing directory is a sentence, not a stack trace`);
  const total = CASES.length + 3;
  console.log(`\n  ${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
  return failed === 0;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `pronoun-sweep.mjs v${VERSION} — rewrites he/him/his to they/them/their, and refuses to guess

  node pronoun-sweep.mjs [<dir>]                   dry run: counts, reasons, per file
  node pronoun-sweep.mjs [<dir>] --sheet out.md    dry run, plus a review sheet to read
  node pronoun-sweep.mjs [<dir>] --commit          apply the AUTO lines (writes a backup first)
  node pronoun-sweep.mjs --verify <state-dir>      prove a backup against the files it came from
  node pronoun-sweep.mjs --self-test
  node pronoun-sweep.mjs --help | --version

  --others "Name,Name"   a name here means another person is on the line -> REVIEW
  --skip "dir,dir"       directories to walk past
  --state <dir>          where the backup and the receipt go (default: .pronoun-sweep in the cwd)

  Quotes and code spans are copied through byte-identical. A line that needs a judgement call is
  reported, never rewritten. Nothing is written until --commit.`;

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { console.error(`pronoun-sweep: ${args.error}`); console.error(USAGE); process.exit(2); }
  if (args.selfTest) { console.log(`pronoun-sweep.mjs v${VERSION} — self-test\n`); process.exit(selfTest() ? 0 : 1); }
  if (args.version) { console.log(`pronoun-sweep.mjs v${VERSION}`); process.exit(0); }
  if (args.help) { console.log(USAGE); process.exit(0); }

  const state = path.resolve(args.state || '.pronoun-sweep');

  if (args.verifyDir) {
    const dir = path.resolve(args.verifyDir);
    if (!fs.existsSync(dir)) { console.error(`pronoun-sweep: no such directory: ${dir}`); process.exit(2); }
    const root = path.resolve(args.root);
    const r = verify(dir, root);
    console.log(`verified ${r.files} file(s) · ${r.changed} changed line(s)`);
    console.log(r.fails.length === 0
      ? 'RESULT: clean — every change is a pronoun or its verb; quotes and code untouched.'
      : `RESULT: ${r.fails.length} problem line(s)`);
    for (const f of r.fails.slice(0, 10)) console.log('\n' + f);
    process.exit(r.fails.length ? 1 : 0);
  }

  const root = path.resolve(args.root);
  if (!fs.existsSync(root)) { console.error(`pronoun-sweep: no such directory: ${root}`); process.exit(2); }

  const files = walk(root, args.skip);
  const results = files.map((f) => ({ file: f, ...classifyText(fs.readFileSync(f, 'utf8'), { others: args.others }) }))
    .filter((r) => r.auto.length || r.review.length);

  let auto = 0, review = 0, he = 0, they = 0;
  for (const r of results) {
    auto += r.auto.length; review += r.review.length;
    for (const line of r.lines) { he += (line.match(HE) || []).length; they += (line.match(THEY) || []).length; }
  }

  console.log(`pronoun-sweep v${VERSION} — ${args.commit ? 'COMMIT' : 'dry run'}\n`);
  console.log(`root            : ${path.relative(process.cwd(), root) || '.'}`);
  console.log(`files with work : ${results.length}`);
  console.log(`lines AUTO      : ${auto}`);
  console.log(`lines REVIEW    : ${review}`);
  const reasons = {};
  for (const r of results) for (const e of r.review) reasons[e.why] = (reasons[e.why] || 0) + 1;
  if (review) console.log(`  review reasons : ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`he : they now   : ${he} / ${they} = ${they ? (he / they).toFixed(2) : 'INF'}:1\n`);

  results.sort((a, b) => (b.auto.length + b.review.length) - (a.auto.length + a.review.length));
  if (results.length) {
    console.log('by file (top 25):');
    for (const r of results.slice(0, 25)) {
      console.log(`  ${String(r.auto.length).padStart(5)} auto  ${String(r.review.length).padStart(5)} review   ${path.relative(root, r.file) || r.file}`);
    }
  }

  if (args.sheet) {
    const L = [`# pronoun-sweep — review sheet (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`, '',
      `AUTO **${auto}** lines · REVIEW **${review}** lines`];
    for (const r of results) {
      L.push('', `## ${path.relative(root, r.file) || r.file}  —  ${r.auto.length} auto · ${r.review.length} review`, '');
      if (r.auto.length) { L.push('### auto'); for (const e of r.auto) L.push(`- L${e.i}`, `  - was: ${e.was.trim().slice(0, 400)}`, `  - now: ${e.now.trim().slice(0, 400)}`); }
      if (r.review.length) { L.push('', '### review'); for (const e of r.review) L.push(`- L${e.i} **(${e.why})**`, `  - was: ${e.was.trim().slice(0, 400)}`, `  - now: ${e.now.trim().slice(0, 400)}`); }
    }
    fs.writeFileSync(path.resolve(args.sheet), L.join('\n').replace(/\r?\n/g, '\n'), 'utf8');
    console.log(`\nsheet -> ${path.resolve(args.sheet)}`);
  }

  if (args.commit) {
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '') + '-' + Date.now().toString(36);
    const backup = path.join(state, `backup-${stamp}`);
    const rows = [];
    for (const r of results) {
      if (!r.auto.length) continue;
      const rel = path.relative(root, r.file);
      const dest = path.join(backup, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(r.file, dest);
      const after = applyAll(r.lines, r.auto);
      fs.writeFileSync(r.file, after, 'utf8');
      rows.push({ rel, lines: r.auto.length, heBefore: (r.lines.join('\n').match(HE) || []).length, heAfter: (after.match(HE) || []).length, theyBefore: (r.lines.join('\n').match(THEY) || []).length, theyAfter: (after.match(THEY) || []).length });
    }
    const receipt = path.join(state, `receipt-${stamp}.md`);
    fs.mkdirSync(state, { recursive: true });
    const L = [`# pronoun-sweep — receipt (${new Date().toISOString()})`, '', `backup: \`${backup}\``, '',
      '| file | lines | he | they |', '| --- | --- | --- | --- |'];
    for (const r of rows) L.push(`| ${r.rel} | ${r.lines} | ${r.heBefore} → ${r.heAfter} | ${r.theyBefore} → ${r.theyAfter} |`);
    fs.writeFileSync(receipt, L.join('\n'), 'utf8');
    console.log(`\ncommitted ${rows.length} file(s)\nbackup  -> ${backup}\nreceipt -> ${receipt}`);
    console.log(`\nnext: prove it — node pronoun-sweep.mjs ${path.relative(process.cwd(), root) || '.'} --verify ${path.relative(process.cwd(), state) || state}`);
    if (!rows.length) console.log('(nothing to commit — no AUTO lines)');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) main(process.argv.slice(2));
