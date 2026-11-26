#!/usr/bin/env node
// pronoun-sweep.mjs — rewrites one set of pronouns to another, and refuses to guess.
//
// WHY IT IS SHAPED THIS WAY. A blind find-and-replace on pronouns is the easiest way there is to
// damage a document: it rewrites the inside of quotations, it mangles code, it changes sentences
// that were about somebody else, and it gets the verb wrong. So this tool is built the other way
// round — it makes only the changes it can defend, and it hands every ambiguous line to a person.
//
// AND IT IS NOT ONE SWAP. he -> they is one person's case, not the tool's. Any set of pronouns can
// be replaced by any other: she/her to they/them, he/him to she/her, they/them back to he/him, or a
// set you define yourself (xe/xem/xyr/xyrs/xemself). The tool ships knowing he, she, they and it,
// because those are the ones most prose uses — and it takes yours.
//
// THE RULES
//   · quoted spans ("..." and “...”) and code spans (`...`) are copied through BYTE-IDENTICAL.
//     A quote keeps every word it was given.
//   · metalanguage is never touched: `he/him`, `she/her` — a slash-pair names the pronoun itself.
//   · the VERB only moves when the two sets need different agreement: he -> they rewrites "he is"
//     to "they are", he -> she leaves the verb exactly where it was. When the verb must move and
//     it is a word this tool does not know, the line goes to REVIEW.
//   · "his" is read in context: "his book" -> "their book", but "the book is his" -> "theirs".
//   · a line goes to REVIEW, not AUTO, when it mentions somebody else (--others), carries an
//     ambiguous contraction, has an odd number of quote marks, or needs a verb it cannot supply.
//   · --verify proves the result: for every changed line the protected spans must be unchanged and
//     the text must differ only in pronouns and their verbs. Nothing else is allowed to move.
//
// USAGE
//   node pronoun-sweep.mjs [<dir>]                       dry run: counts, reasons, per file
//   node pronoun-sweep.mjs [<dir>] --sheet out.md        dry run, plus a review sheet to read
//   node pronoun-sweep.mjs [<dir>] --commit              apply the AUTO lines (backup + receipt)
//   node pronoun-sweep.mjs [<dir>] --verify <state>      prove a backup against the files it came from
//   node pronoun-sweep.mjs --list-pronouns               the sets it ships with, and how to write one
//   node pronoun-sweep.mjs --self-test
//
//   --from <set>           the pronouns being replaced     (default: he)
//   --to <set>             the pronouns being written      (default: they)
//   --others "Name,Name"   names that mean "another person is being discussed" -> REVIEW
//   --skip "dir,dir"       directories to walk past (default: .git, node_modules, .pronoun-sweep)
//   --state <dir>          where the backup and receipt go (default: .pronoun-sweep in the cwd)
//
//   A set is a name (he, she, they, it) or five forms: subj/obj/poss/possPronouns/reflexive,
//   with ":plural" when the set takes plural verbs — xe/xem/xyr/xyrs/xemself:plural
//
// Dry run by default. Nothing is written until --commit, and --commit writes a backup first.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.1.0';

const SELF = fileURLToPath(import.meta.url);

// ---------------------------------------------------------------------------------------------
// The sets it ships with
// ---------------------------------------------------------------------------------------------

export const SETS = {
  he: { name: 'he', subj: 'he', obj: 'him', poss: 'his', possPron: 'his', refl: 'himself', plural: false },
  she: { name: 'she', subj: 'she', obj: 'her', poss: 'her', possPron: 'hers', refl: 'herself', plural: false },
  they: { name: 'they', subj: 'they', obj: 'them', poss: 'their', possPron: 'theirs', refl: 'themselves', plural: true },
  it: { name: 'it', subj: 'it', obj: 'it', poss: 'its', possPron: 'its', refl: 'itself', plural: false },
};

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const matchCase = (out, saw) => (saw && saw[0] === saw[0].toUpperCase() && saw[0] !== saw[0].toLowerCase() ? cap(out) : out);

/**
 * A set: a shipped name, or five forms written out — subj/obj/possessive/possessive-pronoun/
 * reflexive — with an optional ":plural" when the set takes plural verb agreement.
 * Returns null when the spec cannot be read, so the caller can say so plainly.
 */
export function parseSet(spec) {
  if (!spec) return null;
  const [body, ...mods] = String(spec).split(':');
  const named = SETS[body.trim().toLowerCase()];
  if (named && mods.length === 0) return named;
  const parts = body.split('/').map((s) => s.trim()).filter(Boolean);
  if (parts.length !== 5 || parts.some((p) => /\s/.test(p))) return null;
  const [subj, obj, poss, possPron, refl] = parts;
  return { name: `${subj}/${obj}`, subj, obj, poss, possPron, refl, plural: mods.some((m) => /^pl/i.test(m)) };
}

/** The words a reader would call pronouns — used by --verify to canonicalise a line. */
const PRONOUN_WORDS = ['he', 'him', 'his', 'himself', 'she', 'her', 'hers', 'herself',
  'they', 'them', 'their', 'theirs', 'themselves', 'it', 'its', 'itself'];

// ---------------------------------------------------------------------------------------------
// Building the rules for one pair of sets
// ---------------------------------------------------------------------------------------------

/** The verbs that move with the pronoun, when the two sets disagree about agreement. */
const SINGULAR_VERBS = [['is', 'are'], ['was', 'were'], ['has', 'have'], ['does', 'do'],
  ["isn't", "aren't"], ["wasn't", "weren't"], ["hasn't", "haven't"], ["doesn't", "don't"]];

/**
 * What has to change, given where we are going. `phrases` run before the bare words, so "he is"
 * becomes "they are" instead of "they is"; `pairs` are the pronouns themselves.
 */
export function buildRules(from, to) {
  const movesVerb = from.plural !== to.plural;
  const phrases = [];
  // "he's been" is unambiguous (HAS + participle), so it is safe either way
  phrases.push([new RegExp(`\\b${esc(from.subj)}['\u2019]s been\\b`, 'gi'), `${to.subj}${to.plural ? "'ve" : "'s"} been`]);
  phrases.push([new RegExp(`\\b${esc(from.subj)}['\u2019]s got\\b`, 'gi'), `${to.subj}${to.plural ? "'ve" : "'s"} got`]);
  if (movesVerb) {
    for (const [a, b] of SINGULAR_VERBS) {
      const [x, y] = from.plural ? [b, a] : [a, b];   // read it from the source's side
      phrases.push([new RegExp(`\\b${esc(from.subj)} ${esc(x)}\\b`, 'gi'), `${to.subj} ${y}`]);
    }
  }
  // The contractions. "'s" is IS or HAS and "'re" is ARE, so the arriving subject decides the
  // form — and this has to run before the forms pass, or "it's cold" reads the "it" inside the
  // contraction and writes "they's cold". ("it's cold" is IS, so the suggestion is "they're";
  // where "'s" could be HAS the line still goes to review, because only the line can say.)
  const contracted = to.plural ? "'re" : "'s";
  phrases.push([new RegExp(`\\b${esc(from.subj)}['\u2019]re\\b`, 'gi'), `${to.subj}${contracted}`]);
  phrases.push([new RegExp(`\\b${esc(from.subj)}['\u2019]s\\b`, 'gi'), `${to.subj}${contracted}`]);
  // 'd and 'll are the same word in every set
  phrases.push([new RegExp(`\\b${esc(from.subj)}['\u2019]d\\b`, 'gi'), `${to.subj}'d`]);
  phrases.push([new RegExp(`\\b${esc(from.subj)}['\u2019]ll\\b`, 'gi'), `${to.subj}'ll`]);

  const seen = new Set();
  const pairs = [];
  for (const [kind, a, b] of [['subj', from.subj, to.subj], ['obj', from.obj, to.obj],
    ['poss', from.poss, to.poss], ['possPron', from.possPron, to.possPron], ['refl', from.refl, to.refl]]) {
    if (!a || !b || a === b) continue;
    const key = `${a}>${b}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ kind, re: new RegExp(`\\b${esc(a)}\\b`, 'gi'), to: b });
  }

  const forms = [...new Set([from.subj, from.obj, from.poss, from.possPron, from.refl].filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  return { from, to, movesVerb, phrases, pairs, forms, formsRe: new RegExp(`\\b(${forms.map(esc).join('|')})\\b`, 'gi') };
}

/** The possessive "his" points two ways — at a noun ("his book") or at the thing owned ("theirs"). */
const PRONOUN_CONTEXT = /^\s*($|[.,;:!?)\]}"'\u201D\u2019\u2014-]|and\b|or\b|but\b)/;

// ---------------------------------------------------------------------------------------------
// The role — the thing this tool used to decide by rule order
// ---------------------------------------------------------------------------------------------
//
// Every form carries a grammatical role: subject, object, possessive determiner, possessive
// pronoun, or reflexive. When a set uses one word for two roles — "her" is both the object and
// the determiner; "it" is both the subject and the object — the role has to be read off the
// sentence, because the word alone cannot say which one it is.
//
// That was the bug (Carrious's issue #1, reproduced 2026-11-25): the rules ran subject, then
// object, then possessive, so "her" was always caught by the object rule — "she lost her book"
// became "they lost them book" — and "it" was always caught by the subject rule — "the dog
// dropped it" became "the dog dropped they". The order decided, not the grammar.
//
// The two calls below are the whole of it, and both are stated so they can be argued with:
// a possessive determiner is followed by the noun phrase it belongs to; a subject is at the
// head of a clause. Where neither test can call it, roleOf returns null and the line goes to
// review — the tool refuses, which is what it has always claimed to do.

/** Words that cannot begin the noun phrase after a determiner — so "her" before one is the object. */
const NOT_A_NOUN_START = new Set(['yesterday', 'today', 'tomorrow', 'tonight', 'again', 'too', 'now',
  'then', 'still', 'already', 'back', 'home', 'there', 'here', 'out', 'up', 'down', 'off', 'away',
  'in', 'on', 'at', 'for', 'with', 'and', 'or', 'but', 'so', 'as', 'that', 'which', 'who', 'when',
  'if', 'while', 'because', 'since', 'though', 'although', 'unless', 'until', 'not', 'never',
  'always', 'just', 'even', 'only', 'also', 'instead', 'anyway', 'later', 'soon', 'once', 'twice',
  'before', 'after', 'over', 'under', 'around', 'through', 'against', 'about', 'more', 'most',
  'very', 'well', 'much', 'least', 'else', 'either', 'neither', 'both', 'all', 'any', 'some']);

/** Words that open a clause — a subject can stand right after one. */
const CLAUSE_STARTERS = new Set(['and', 'or', 'but', 'so', 'then', 'when', 'if', 'while', 'because',
  'since', 'though', 'although', 'that', 'which', 'who', 'where', 'unless', 'until', 'as', 'than',
  'yet', 'nor', 'once', 'before', 'after', 'til', 'till', 'whenever', 'wherever', 'whether']);

/** An auxiliary before the pronoun is inversion ("does it work") or a plain object ("I did it") —
 *  the two read the same from here, so the line goes to review rather than being guessed. */
const AUXILIARY = new Set(['is', 'are', 'was', 'were', 'do', 'does', 'did', 'can', 'could', 'will',
  'would', 'shall', 'should', 'may', 'might', 'must', 'has', 'have', 'had']);

/**
 * What role `word` is playing, given the text either side of it and the set it came from.
 * Null means the tool cannot say — and a null is never turned into a guess.
 */
export function roleOf(word, before, after, set) {
  const w = String(word).toLowerCase();
  const cand = ['subj', 'obj', 'poss', 'possPron', 'refl'].filter((k) => set && set[k] && set[k].toLowerCase() === w);
  if (cand.length === 0) return null;
  if (cand.length === 1) return cand[0];

  const nextTok = (after.match(/^\s*[^\s]+/) || [''])[0].trim();
  const next = nextTok.toLowerCase().replace(/[^a-z'-].*$/, '');
  const prevTok = (before.replace(/\s+$/, '').match(/[^\s]+$/) || [''])[0];
  const prev = prevTok.toLowerCase().replace(/[^a-z'-].*$/, '');

  // his: a noun phrase after it makes it the determiner; the clause's end makes it the pronoun
  if (cand.includes('poss') && cand.includes('possPron')) {
    return PRONOUN_CONTEXT.test(after) ? 'possPron' : 'poss';
  }
  // her: "her book" is the determiner, "saw her" and "saw her yesterday" are the object
  if (cand.includes('poss') && cand.includes('obj')) {
    if (!next) return 'obj';
    if (NOT_A_NOUN_START.has(next) || /ly$/.test(next)) return 'obj';
    return 'poss';
  }
  // it: at the head of a clause it is the subject, after a verb or preposition it is the object
  if (cand.includes('subj') && cand.includes('obj')) {
    if (!prevTok) return 'subj';
    if (/[.!?;:,]\s*$/.test(prevTok)) return 'subj';
    if (AUXILIARY.has(prev)) return null;
    if (CLAUSE_STARTERS.has(prev)) return 'subj';
    return 'obj';
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Protected spans and the rewrite
// ---------------------------------------------------------------------------------------------

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

/** Replace inside one unprotected segment. Phrases first, then the pronouns. Never across `/`. */
export function applyRules(seg, rules) {
  let n = 0, unknown = 0;
  for (const [re, to] of rules.phrases) seg = seg.replace(re, (m) => { n++; return matchCase(to, m); });
  if (!rules.formsRe) return [seg, n, unknown];
  // one pass over every source form: the role at that position decides the word, and where the
  // role cannot be read the word is left alone and counted — never resolved by which rule ran first
  seg = seg.replace(rules.formsRe, (m, ...rest) => {
    const off = rest[rest.length - 2], whole = rest[rest.length - 1];
    const before = whole[off - 1], after = whole[off + m.length];
    if (before === '/' || after === '/') return m;      // metalanguage: he/him names the pronoun
    const role = roleOf(m, whole.slice(0, off), whole.slice(off + m.length), rules.from);
    if (!role) { unknown++; return m; }
    const out = rules.to[role];
    if (!out) return m;
    n++;
    return matchCase(out, m);
  });
  return [seg, n, unknown];
}

/** The line rewritten, with every protected span copied through untouched. */
export function rewrite(line, rules) {
  const cuts = spans(line).sort((a, b) => a[0] - b[0]);
  let outStr = '', i = 0, changed = 0, unknown = 0;
  for (const [a, b] of cuts) {
    const [r, n, u] = applyRules(line.slice(i, a), rules);
    outStr += r; changed += n; unknown += u; outStr += line.slice(a, b); i = b;
  }
  const [r, n, u] = applyRules(line.slice(i), rules);
  outStr += r; changed += n; unknown += u;
  return [outStr, changed, unknown];
}

/** Everything outside the protected spans — what the agreement check is allowed to read. */
export function outside(line) {
  const prot = spans(line).sort((a, b) => a[0] - b[0]);
  let s = '', i = 0;
  for (const [a, b] of prot) { s += line.slice(i, a); i = b; }
  return s + line.slice(i);
}

/** Words that end in -s but are not verbs needing agreement. */
const STOP = new Set(['his', 'hers', 'its', 'this', 'these', 'those', 'ours', 'yours', 'theirs',
  'less', 'yes', 'plus', 'thus', 'else', 'twice', 'once', 'always', 'perhaps', 'across']);

/**
 * Verb agreement, the part no rule can fix: when the sets disagree, a present-tense lexical verb
 * after the subject ("he types" -> "they types") has to become something this tool cannot invent.
 */
export function agreement(text, subject) {
  const re = new RegExp(`\\b${esc(subject)}\\b`, 'gi');
  let m;
  while ((m = re.exec(text))) {
    const tail = text.slice(m.index + m[0].length).split(/\s+/).slice(0, 3).join(' ');
    for (const tok of tail.split(/\s+/)) {
      const w = tok.replace(/[^A-Za-z]+$/, '');
      if (!w || w.toLowerCase() === subject.toLowerCase()) continue;
      if (/^[A-Za-z]{3,}s$/.test(w) && !STOP.has(w.toLowerCase())) return true;
    }
  }
  return false;
}

/** One line in, one verdict out. The whole policy, in one function, so the self-test can call it. */
export function classify(line, { rules, others = [] }) {
  if (!rules) return null;
  const from = rules.from;
  const sourceWords = [from.subj, from.obj, from.poss, from.possPron, from.refl].filter(Boolean);
  if (!new RegExp(`\\b(${sourceWords.map(esc).join('|')})\\b`, 'i').test(line)) return null;
  const [now, n, unknown] = rewrite(line, rules);
  if (!n && !unknown) return null;                       // nothing outside a quote or code span

  // the one Carrious found: a form that plays two roles and whose role this tool cannot read
  if (unknown) return { kind: 'review', why: 'a pronoun whose role it cannot place', was: line, now };

  if (others.length && new RegExp(`\\b(${others.map(esc).join('|')})\\b`).test(line)) {
    return { kind: 'review', why: 'names another person', was: line, now };
  }
  // "'s" is IS or HAS — only safe to carry across when both sets take the same verb
  if (rules.movesVerb && new RegExp(`\\b${esc(from.subj)}['\u2019]s\\b`, 'i').test(line)
    && !new RegExp(`\\b${esc(from.subj)}['\u2019]s (been|got)\\b`, 'i').test(line)) {
    return { kind: 'review', why: 'ambiguous contraction', was: line, now };
  }
  if (rules.movesVerb && agreement(outside(line), from.subj)) {
    return { kind: 'review', why: 'agreement', was: line, now };
  }
  if ((line.match(/["\u201C\u201D]/g) || []).length % 2 === 1) {
    return { kind: 'review', why: 'odd quotes', was: line, now };
  }
  return { kind: 'auto', was: line, now };
}

/** A whole document: the lines this tool would change, and the ones it will only report. */
export function classifyText(text, opts) {
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
 * Canonical form: every pronoun becomes the ROLE it is playing, every verb that agreement can
 * touch becomes a token. The role is the whole point — collapsing a pronoun to one generic token
 * is what let the proof certify "they lost them book" as clean, because both lines reduced to the
 * same thing. A role that cannot be read becomes `PRON_?`, which keeps a line from passing on a
 * reading nobody could make.
 */
export function canon(s, rules = null) {
  const extra = rules ? [rules.from, rules.to].flatMap((x) => [x.subj, x.obj, x.poss, x.possPron, x.refl]) : [];
  const all = [...new Set([...PRONOUN_WORDS, ...extra].filter(Boolean))].sort((a, b) => b.length - a.length);
  const sets = rules ? [rules.from, rules.to, ...Object.values(SETS)] : Object.values(SETS);
  return s
    .replace(/[\u2019]/g, "'")
    .replace(new RegExp(`\\b(${all.map(esc).join('|')})\\b`, 'gi'), (m, ...rest) => {
      const off = rest[rest.length - 2], whole = rest[rest.length - 1];
      const set = sets.find((x) => x && ['subj', 'obj', 'poss', 'possPron', 'refl']
        .some((k) => x[k] && x[k].toLowerCase() === m.toLowerCase()));
      const role = set ? roleOf(m, whole.slice(0, off), whole.slice(off + m.length), set) : null;
      return role ? `PRON_${role.toUpperCase()}` : 'PRON_?';
    })
    .replace(/\b(doesn't|don't|isn't|aren't|wasn't|weren't|hasn't|haven't)\b/gi, 'AUX')
    .replace(/\b(is|are|was|were|has|have|does|do)\b/gi, 'AUX')
    .replace(/'(s|d|ll|re|ve)\b/gi, 'CON')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The proof. For every file in the backup, compare it to the file on disk line by line: the
 * protected spans must be identical, and once pronouns and their verbs are canonicalised the rest
 * of the line must be identical too. A failure is something that changed which is neither.
 */
export function verify(stateDir, rootDir, rules = null) {
  let base = stateDir;
  if (!path.basename(stateDir).startsWith('backup-')) {
    const cands = fs.readdirSync(stateDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
      .map((e) => path.join(stateDir, e.name)).sort();
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
      if (canon(A[i], rules) !== canon(B[i], rules)) fails.push(`changed more than a pronoun: ${rel} L${i + 1}\n    was: ${A[i].trim().slice(0, 160)}\n    now: ${B[i].trim().slice(0, 160)}`);
    }
  }
  return { files: files.length, changed, fails };
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const values = new Map();
  const flags = new Set();
  const positional = [];
  const takesValue = ['others', 'skip', 'state', 'sheet', 'verify', 'from', 'to'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-') && a.length > 1) {
      const name = a.replace(/^--?/, '');
      if (takesValue.includes(name)) {
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
    from: values.get('from') || 'he',
    to: values.get('to') || 'they',
    others: (values.get('others') || '').split(',').map((s) => s.trim()).filter(Boolean),
    skip: new Set(['.git', 'node_modules', '.pronoun-sweep', ...(values.get('skip') || '').split(',').map((s) => s.trim()).filter(Boolean)]),
    state: values.get('state') || null,
    sheet: values.get('sheet') || null,
    verifyDir: values.get('verify') || null,
    commit: flags.has('commit'),
    help: flags.has('help') || flags.has('h'),
    version: flags.has('version') || flags.has('v'),
    list: flags.has('list-pronouns'),
    selfTest: flags.has('self-test'),
  };
}

// ---------------------------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------------------------

const R = (from = 'he', to = 'they') => buildRules(parseSet(from), parseSet(to));
const runOn = (line, rules, others = []) => classifyText(line, { rules, others });

const CASES = [
  // the default pair, and the verbs that have to move with it
  ['he -> they: a bare pronoun swaps', 'he walked in', (r) => r.auto[0]?.now === 'they walked in'],
  ['he -> they: the capital keeps its case', 'His coat was here', (r) => r.auto[0]?.now === 'Their coat was here'],
  ['he -> they: himself becomes themselves', 'he taught himself', (r) => r.auto[0]?.now === 'they taught themselves'],
  ['he -> they: he is becomes they are', 'he is late', (r) => r.auto[0]?.now === 'they are late'],
  ['he -> they: he has becomes they have', "he hasn't called", (r) => r.auto[0]?.now === "they haven't called"],
  ['he -> they: he has been becomes they have been', "he's been late", (r) => r.auto[0]?.now === "they've been late"],

  // the possessive that points two ways
  ['his before a noun is the determiner', 'his book is here', (r) => r.auto[0]?.now === 'their book is here'],
  ['his at the end is the possessive pronoun', 'the book is his', (r) => r.auto[0]?.now === 'the book is theirs'],

  // the role decides, not the order the rules happen to run in — Carrious's issue #1, 2026-11-25
  ['#1: her before a noun is the determiner', 'she lost her book', (r) => r.auto[0]?.now === 'they lost their book', R('she', 'they')],
  ['#1: her at a clause end is the object', 'I saw her', (r) => r.auto[0]?.now === 'I saw them', R('she', 'they')],
  ['her before an adverb is still the object', 'I saw her yesterday', (r) => r.auto[0]?.now === 'I saw them yesterday', R('she', 'they')],
  ['#1: it after a verb is the object', 'the dog dropped it', (r) => r.auto[0]?.now === 'the dog dropped them', R('it', 'they')],
  ['it at the head of a clause is the subject', 'it was cold', (r) => r.auto[0]?.now === 'they were cold', R('it', 'they')],
  ['an auxiliary before it cannot be read, so it refuses', 'I did it', (r) => r.review[0]?.why === 'a pronoun whose role it cannot place', R('it', 'they')],
  ["a contraction keeps its subject's job", "it's cold", (r) => r.review[0]?.why === 'ambiguous contraction' && r.review[0]?.now === "they're cold", R('it', 'they')],

  // the pairs that are not ours — this is the point of the change
  ['he -> she: the pronoun swaps', 'he walked in', (r) => r.auto[0]?.now === 'she walked in', R('he', 'she')],
  ['he -> she: the verb does not move', 'he is late', (r) => r.auto[0]?.now === 'she is late', R('he', 'she')],
  ['he -> she: his before a noun becomes her', 'his book', (r) => r.auto[0]?.now === 'her book', R('he', 'she')],
  ['he -> she: his at the end becomes hers', 'the book is his', (r) => r.auto[0]?.now === 'the book is hers', R('he', 'she')],
  ['she -> they: the verb moves', 'she is late', (r) => r.auto[0]?.now === 'they are late', R('she', 'they')],
  ['they -> he: the verb moves back', 'they are late', (r) => r.auto[0]?.now === 'he is late', R('they', 'he')],
  ['they -> she: their before a noun becomes her', 'their book', (r) => r.auto[0]?.now === 'her book', R('they', 'she')],

  // a set the tool has never heard of
  ['a custom set is read from five forms', 'xe is late', (r) => r.auto[0]?.now === 'they are late', R('xe/xem/xyr/xyrs/xemself', 'they')],
  ['a custom plural set moves the verb back to a singular one', 'fae are late', (r) => r.auto[0]?.now === 'he is late', R('fae/faer/faer/faers/faerself:plural', 'he')],

  // the rules that never move
  ['a quoted span is untouched', 'he said "he was tired" and left', (r) => r.auto[0]?.now === 'they said "he was tired" and left'],
  ['a quote alone is not a change', 'she said "he was tired"', (r) => r.auto.length === 0 && r.review.length === 0],
  ['a code span is untouched', 'call `he` here', (r) => r.auto.length === 0],
  ['he/him is never rewritten', 'pronouns: he/him', (r) => r.auto.length === 0 && r.review.length === 0],
  ['another person on the line goes to review', 'Dana said he would', (r) => r.review[0]?.why === 'names another person', R(), ['Dana']],
  ['an ambiguous contraction goes to review', "he's late", (r) => r.review[0]?.why === 'ambiguous contraction'],
  ['the same contraction is safe when the verb matches', "he's late", (r) => r.auto[0]?.now === "she's late", R('he', 'she')],
  ['a present-tense verb goes to review', 'he types quickly', (r) => r.review[0]?.why === 'agreement'],
  ['an odd quote count goes to review', 'he said "hello', (r) => r.review[0]?.why === 'odd quotes'],

  // and the proof
  ['the verifier accepts a pure swap', null, () => {
    const before = 'he walked in and sat down';
    const after = rewrite(before, R())[0];
    return canon(before) === canon(after) && JSON.stringify(spans(before)) === JSON.stringify(spans(after));
  }],
  ['the verifier rejects a reworded line', null, () => canon('he walked in') !== canon('they walked in slowly')],
  ['the proof passes a correct rewrite', null, () => canon('she lost her book', R('she', 'they')) === canon('they lost their book', R('she', 'they'))],
  ['the proof fails the wrong form, though a pronoun did move', null, () => canon('she lost her book', R('she', 'they')) !== canon('they lost them book', R('she', 'they'))],
  ['the proof fails the object where the subject belonged', null, () => canon('the dog dropped it', R('it', 'they')) !== canon('the dog dropped they', R('it', 'they'))],
];

function selfTest() {
  let failed = 0;
  const check = (name, ok, detail = '') => { if (!ok) failed++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
  for (const [name, line, fn, rules, others] of CASES) {
    let ok = false, detail = '';
    try {
      if (line === null) ok = Boolean(fn());
      else ok = Boolean(fn(runOn(line, rules || R(), others || [])));
    } catch (e) { detail = e.message; }
    check(name, ok, detail);
  }
  const run = (args) => spawnSync(process.execPath, [SELF, ...args], { encoding: 'utf8' });
  const help = run(['--help']);
  check('--help is an answer, not an error', help.status === 0 && help.stdout.includes('--from'));
  const ver = run(['--version']);
  check('--version names the version', ver.status === 0 && ver.stdout.includes(VERSION));
  const list = run(['--list-pronouns']);
  check('--list-pronouns names the sets it ships with', list.status === 0 && ['himself', 'herself', 'themselves', 'itself'].every((w) => list.stdout.includes(w)));
  const bad = run(['--from', 'nope']);
  check('a set it cannot read is a sentence, not a guess', bad.status === 2 && /cannot read/i.test(bad.stderr));
  const missing = run(['--verify', 'a-directory-that-is-not-here']);
  check('a missing directory is a sentence, not a stack trace', missing.status === 2 && /no such/i.test(missing.stderr) && !/\n\s+at /.test(missing.stderr));
  const total = CASES.length + 5;
  console.log(`\n  ${total - failed}/${total} passed${failed ? ` — ${failed} FAILED` : ''}`);
  return failed === 0;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `pronoun-sweep.mjs v${VERSION} — rewrites one set of pronouns to another, and refuses to guess

  node pronoun-sweep.mjs [<dir>]                   dry run: counts, reasons, per file
  node pronoun-sweep.mjs [<dir>] --sheet out.md    dry run, plus a review sheet to read
  node pronoun-sweep.mjs [<dir>] --commit          apply the AUTO lines (writes a backup first)
  node pronoun-sweep.mjs [<dir>] --verify <state>  prove a backup against the files it came from
  node pronoun-sweep.mjs --list-pronouns           the sets it ships with, and how to write your own
  node pronoun-sweep.mjs --self-test
  node pronoun-sweep.mjs --help | --version

  --from <set>           the pronouns being replaced     (default: he)
  --to <set>             the pronouns being written      (default: they)
  --others "Name,Name"   a name here means another person is on the line -> REVIEW
  --skip "dir,dir"       directories to walk past
  --state <dir>          where the backup and the receipt go (default: .pronoun-sweep in the cwd)

  A set is he, she, they or it, or five forms written out:
      subj/obj/possessive/possessive-pronoun/reflexive
      --to "xe/xem/xyr/xyrs/xemself"                xe takes a singular verb
      --to "fae/faer/faer/faers/faerself:plural"    :plural when the set takes plural verbs

  Quotes and code spans are copied through byte-identical. A line that needs a judgement call is
  reported, never rewritten. Nothing is written until --commit.`;

function fail(msg) { console.error(`pronoun-sweep: ${msg}`); process.exit(2); }

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) { console.error(`pronoun-sweep: ${args.error}`); console.error(USAGE); process.exit(2); }
  if (args.selfTest) { console.log(`pronoun-sweep.mjs v${VERSION} — self-test\n`); process.exit(selfTest() ? 0 : 1); }
  if (args.version) { console.log(`pronoun-sweep.mjs v${VERSION}`); process.exit(0); }
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.list) {
    console.log('pronoun-sweep — the sets it ships with\n');
    for (const s of Object.values(SETS)) {
      console.log(`  ${s.name.padEnd(6)} ${s.subj}/${s.obj}/${s.poss}/${s.possPron}/${s.refl}${s.plural ? '   (plural verb)' : '   (singular verb)'}`);
    }
    console.log('\nyour own, as five forms:');
    console.log('  --from "subj/obj/possessive/possessive-pronoun/reflexive"');
    console.log('  --to   "xe/xem/xyr/xyrs/xemself"              singular verb');
    console.log('  --to   "fae/faer/faer/faers/faerself:plural"  plural verb');
    console.log('\nexamples:');
    console.log('  --from he --to they      the default');
    console.log('  --from he --to she       the verb stays where it is');
    console.log('  --from they --to she     the verb moves back');
    process.exit(0);
  }

  const from = parseSet(args.from);
  const to = parseSet(args.to);
  if (!from) fail(`cannot read --from "${args.from}" — use he, she, they, it, or five forms: subj/obj/poss/possPron/reflexive`);
  if (!to) fail(`cannot read --to "${args.to}" — use he, she, they, it, or five forms: subj/obj/poss/possPron/reflexive`);
  const rules = buildRules(from, to);

  if (args.verifyDir) {
    const dir = path.resolve(args.verifyDir);
    if (!fs.existsSync(dir)) fail(`no such directory: ${dir}`);
    const r = verify(dir, path.resolve(args.root), rules);
    console.log(`verified ${r.files} file(s) · ${r.changed} changed line(s)`);
    console.log(r.fails.length === 0
      ? 'RESULT: clean — every change is a pronoun or its verb; quotes and code untouched.'
      : `RESULT: ${r.fails.length} problem line(s)`);
    for (const f of r.fails.slice(0, 10)) console.log('\n' + f);
    process.exit(r.fails.length ? 1 : 0);
  }

  const root = path.resolve(args.root);
  if (!fs.existsSync(root)) fail(`no such directory: ${root}`);

  const files = walk(root, args.skip);
  const results = files.map((f) => ({ file: f, ...classifyText(fs.readFileSync(f, 'utf8'), { rules, others: args.others }) }))
    .filter((r) => r.auto.length || r.review.length);

  let auto = 0, review = 0;
  for (const r of results) { auto += r.auto.length; review += r.review.length; }

  console.log(`pronoun-sweep v${VERSION} — ${args.commit ? 'COMMIT' : 'dry run'}\n`);
  console.log(`root            : ${path.relative(process.cwd(), root) || '.'}`);
  console.log(`pronouns        : ${from.subj}/${from.obj} -> ${to.subj}/${to.obj}${rules.movesVerb ? '   (the verb moves)' : '   (the verb stays)'}`);
  console.log(`files with work : ${results.length}`);
  console.log(`lines AUTO      : ${auto}`);
  console.log(`lines REVIEW    : ${review}`);
  const reasons = {};
  for (const r of results) for (const e of r.review) reasons[e.why] = (reasons[e.why] || 0) + 1;
  if (review) console.log(`  review reasons : ${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log('');

  results.sort((a, b) => (b.auto.length + b.review.length) - (a.auto.length + a.review.length));
  if (results.length) {
    console.log('by file (top 25):');
    for (const r of results.slice(0, 25)) {
      console.log(`  ${String(r.auto.length).padStart(5)} auto  ${String(r.review.length).padStart(5)} review   ${path.relative(root, r.file) || r.file}`);
    }
  }

  if (args.sheet) {
    const L = [`# pronoun-sweep — review sheet (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`, '',
      `${from.subj}/${from.obj} -> ${to.subj}/${to.obj}${rules.movesVerb ? ' (the verb moves)' : ''}`, '',
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
    const state = path.resolve(args.state || '.pronoun-sweep');
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
      rows.push({ rel, lines: r.auto.length });
    }
    const receipt = path.join(state, `receipt-${stamp}.md`);
    fs.mkdirSync(state, { recursive: true });
    const L = [`# pronoun-sweep — receipt (${new Date().toISOString()})`, '',
      `pronouns: ${from.subj}/${from.obj} -> ${to.subj}/${to.obj}`, '', `backup: \`${backup}\``, '',
      '| file | lines changed |', '| --- | --- |'];
    for (const r of rows) L.push(`| ${r.rel} | ${r.lines} |`);
    fs.writeFileSync(receipt, L.join('\n'), 'utf8');
    console.log(`\ncommitted ${rows.length} file(s)\nbackup  -> ${backup}\nreceipt -> ${receipt}`);
    if (!rows.length) console.log('(nothing to commit — no AUTO lines)');
    else console.log(`\nnext: prove it — node pronoun-sweep.mjs "${path.relative(process.cwd(), root) || '.'}" --verify "${path.relative(process.cwd(), state) || state}" --from "${from.name}" --to "${to.name}"`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) main(process.argv.slice(2));
