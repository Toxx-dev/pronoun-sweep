# pronoun-sweep

[![self-test](https://github.com/Toxx-dev/pronoun-sweep/actions/workflows/test.yml/badge.svg)](https://github.com/Toxx-dev/pronoun-sweep/actions/workflows/test.yml)

**Rewrites one set of pronouns to another — and refuses to guess.** `he/him` to `they/them`, `he/him` to `she/her`, `she/her` back to `he/him`, or a set you write yourself. One file, zero dependencies, offline. Quoted spans and code are copied through byte-identical; anything that needs a judgement call is reported, never rewritten.

```bash
node pronoun-sweep.mjs --self-test
```

```text
pronoun-sweep.mjs v0.1.0 — self-test

  PASS  he -> they: a bare pronoun swaps
  PASS  #1: her before a noun is the determiner
  PASS  #1: it after a verb is the object
  PASS  an auxiliary before it cannot be read, so it refuses
  PASS  he -> she: the verb does not move
  PASS  they -> he: the verb moves back
  PASS  a custom set is read from five forms
  ...
  PASS  the proof fails the wrong form, though a pronoun did move
  PASS  --list-pronouns names the sets it ships with

  43/43 passed
```

## The sets it ships with

```bash
node pronoun-sweep.mjs --list-pronouns
```

```text
pronoun-sweep — the sets it ships with

  he     he/him/his/his/himself   (singular verb)
  she    she/her/her/hers/herself   (singular verb)
  they   they/them/their/theirs/themselves   (plural verb)
  it     it/it/its/its/itself   (singular verb)
```

Any of those can be the source and any can be the target. And if yours is not on the list, write it:

```bash
node pronoun-sweep.mjs ./notes --from he --to "xe/xem/xyr/xyrs/xemself"
node pronoun-sweep.mjs ./notes --from "fae/faer/faer/faers/faerself:plural" --to she
```

Five forms, in order: **subject / object / possessive / possessive-pronoun / reflexive**. Add `:plural` when the set takes plural verbs — `xe is` (no suffix) versus `fae are` (`:plural`). That flag is not cosmetic: it is what tells the tool whether the verb has to move.

## What it does to a folder

Nothing is written until `--commit`.

```bash
node pronoun-sweep.mjs ./notes --from he --to they --others "Dana"
```

```text
pronoun-sweep v0.1.0 — dry run

root            : notes
pronouns        : he/him -> they/them   (the verb moves)
files with work : 1
lines AUTO      : 5
lines REVIEW    : 2
  review reasons : agreement 1 · names another person 1
```

The same document, going the other way:

```bash
node pronoun-sweep.mjs ./notes --from he --to she --others "Dana"
```

```text
pronouns        : he/him -> she/her   (the verb stays)
lines AUTO      : 6
lines REVIEW    : 1
  review reasons : names another person 1
```

**That difference is the whole design.** `he → they` has to move the verb, so `he types` becomes work for a human. `he → she` does not, so the same line is safe and the tool takes it. A tool that applied one rule to both would be wrong in one of the two directions.

And when it commits, it proves itself:

```bash
node pronoun-sweep.mjs ./notes --commit
node pronoun-sweep.mjs ./notes --verify .pronoun-sweep
```

```text
verified 1 file(s) · 5 changed line(s)
RESULT: clean — every change is a pronoun or its verb; quotes and code untouched.
```

## Getting it

```bash
git clone https://github.com/Toxx-dev/pronoun-sweep.git
cd pronoun-sweep

node pronoun-sweep.mjs --self-test
node pronoun-sweep.mjs examples --others "Dana"          # dry run on the example that ships
```

Or put it on your PATH and forget about the clone:

```bash
npm install -g github:Toxx-dev/pronoun-sweep
pronoun-sweep ./notes --from he --to they
```

Node 18 or newer. No dependencies.

## Usage

```bash
node pronoun-sweep.mjs [<dir>]                    # dry run: counts, reasons, per file
node pronoun-sweep.mjs [<dir>] --sheet out.md     # dry run, plus a review sheet to read
node pronoun-sweep.mjs [<dir>] --commit           # apply the AUTO lines (backup written first)
node pronoun-sweep.mjs [<dir>] --verify <state>   # prove the backup against the files it came from
node pronoun-sweep.mjs --list-pronouns
node pronoun-sweep.mjs --self-test
node pronoun-sweep.mjs --help
node pronoun-sweep.mjs --version
```

| flag | what it does |
|---|---|
| `--from <set>` | the pronouns being replaced (default: `he`) |
| `--to <set>` | the pronouns being written (default: `they`) |
| `--others "Name,Name"` | a name here means another person is being discussed, so the line goes to REVIEW |
| `--skip "dir,dir"` | directories to walk past (always: `.git`, `node_modules`, `.pronoun-sweep`) |
| `--state <dir>` | where the backup and the receipt go (default: `.pronoun-sweep` in the current directory) |
| `--sheet <file>` | write the full before/after list to a markdown file you can read |

**Exit codes.** `0` for a dry run and for a clean verify, and for `--help` and `--version`, because asking a question is not an error. `1` when the self-test fails or `--verify` finds a problem. `2` for a usage error, including a set it cannot read or a directory that does not exist — you get a sentence, not a stack trace.

## What it refuses

This is the part worth reading, because it is why the tool exists.

- **Quoted spans are byte-identical.** `"..."` and `“...”` keep every word they were given. A person's quote is their words, not yours to correct.
- **Code spans are byte-identical.** `` `he` `` stays `` `he` ``.
- **Metalanguage is never touched.** `he/him` and `she/her` name the pronoun itself; a slash-pair is a label, not prose.
- **A line that names somebody else goes to REVIEW.** Pass their names with `--others`.
- **An ambiguous contraction goes to REVIEW.** `he's` is *he is* or *he has*, so crossing from a singular set to a plural one is not guessed at. (`he's been` and `he's got` are unambiguous, and those it does.)
- **A present-tense verb goes to REVIEW** when the verb has to move. `he types` would become `they types`, and the tool will not invent `type` for you. When both sets take the same verb, the line is safe and it takes it.
- **An odd number of quote marks goes to REVIEW.** If the quoting is unbalanced, the tool cannot know what is inside it.
- **A pronoun whose role it cannot read goes to REVIEW.** `her` is both the object and the determiner, `it` both the subject and the object. Where the sentence settles which one is in play, the line is rewritten; where it does not, the line is handed over untouched.

A refused line is still shown in the sheet — with its proposed rewrite — so the decision takes seconds instead of a re-read.

## Words that do two jobs

`his`, `her` and `it` each carry more than one role, and the tool reads the sentence around the word to tell them apart — not the word alone, because the word alone cannot say:

| | |
|---|---|
| `his book` | `their book` — the determiner, in front of the noun |
| `the book is his` | `theirs` — the possessive pronoun, standing alone |
| `she lost her book` | `they lost their book` — `her` before a noun is the determiner |
| `I saw her` | `I saw them` — `her` at the end of a clause is the object |
| `her yesterday` | `them yesterday` — an adverb cannot begin a noun phrase, so `her` is the object |
| `the dog dropped it` | `the dog dropped them` — `it` after a verb is the object |
| `it was cold` | `they were cold` — `it` at the head of a clause is the subject |

With `he → she` the same lines become `her book` and `hers`. Getting this wrong is the difference between a correction and a mistake, so every one of these lines is in the suite.

**Where the sentence cannot settle it, the tool does not pick.** A pronoun after an auxiliary is the case to know about: `I did it` and `does it work` read identically from here, one is an object and the other is inverted, so the line goes to review instead of being guessed at. That is the whole policy — it would rather hand you a line than write a wrong one.

## The proof

`--verify` is the other half of the promise. For every file in the backup it compares line by line against the file on disk:

1. the protected spans must be **identical**, and
2. once pronouns, **the role each one is playing**, and the verbs agreement can touch are canonicalised, **the rest of the line must be identical**.

The role is what makes the proof mean anything. Collapsing every pronoun to one token would let `they lost them book` pass as a clean rewrite of `she lost her book` — a pronoun moved, and the wrong one landed. With the role in the canonical form that line fails and the right one passes. So a passing verify says, mechanically: *nothing moved except the pronouns, their roles and their verbs.* If a run changes a word you wrote, or writes the wrong form where the right word belonged, the verify fails and names the line. It is the check the author ran against their own work, shipped so you can run it too.

## What it does not do

- **It is not a find-and-replace**, by design. If you want one, this is the wrong tool.
- **It does not choose your pronouns.** You say what is being replaced and what is being written; the tool has no opinion about who anybody is.
- **It does not rewrite the ambiguous cases.** Lexical verbs, unclear contractions, quotes that mention other people — those stay for a human. That is a smaller diff than you might want, and it is the diff you can defend.
- **It does not handle Markdown structure.** A `#` heading or a list item is just a line; the prose in it is rewritten like any other line.
- **It does not touch files other than `.md`.** No HTML, no source code, no notebooks.

## 中文

**把一组代词换成另一组，并且拒绝猜测。** `he/him` 换成 `they/them`、`she/her`，或者换回 `he/him`；你也可以写自己的五个形式：**主格 / 宾格 / 所有格 / 所有格代词 / 反身**，需要复数动词时加 `:plural`。

```bash
node pronoun-sweep.mjs --list-pronouns                        # 它内置的几组
node pronoun-sweep.mjs ./notes --from he --to they            # 只演练，不写入
node pronoun-sweep.mjs ./notes --from he --to she             # 动词不需要变
node pronoun-sweep.mjs ./notes --from he --to "xe/xem/xyr/xyrs/xemself"
```

引号里的句子、代码块和 `行内代码` 一字不动——引用是别人的话。需要人判断的行只报告：提到别人的名字（`--others`）、有歧义的缩写、动词必须随主语变化、引号数量不对称。**动词只在两组代词需要不同一致性时才变**：`he → they` 会改 `he is`，`he → she` 不会。`--verify` 逐行证明：除了代词和它的动词，什么都没有动。

完整规则见上方英文部分。

## 日本語

**ある代名詞セットを別のセットへ書き換えます。ただし推測はしません。** `he/him` から `they/them` へ、`she/her` へ、また `he/him` へ戻すことも。自分のセットは五つの形で書けます——**主格 / 目的格 / 所有格 / 所有代名詞 / 再帰**、複数動詞を取るなら `:plural` を付けます。

```bash
node pronoun-sweep.mjs --list-pronouns                        # 同梱のセット
node pronoun-sweep.mjs ./notes --from he --to they            # 下見のみ
node pronoun-sweep.mjs ./notes --from he --to she             # 動詞は動かない
node pronoun-sweep.mjs ./notes --from he --to "xe/xem/xyr/xyrs/xemself"
```

引用符の中、コードブロック、`インラインコード` は一文字も変えません。判断が要る行は報告だけ：別の人の名前（`--others`）、曖昧な短縮形、動詞の一致が必要な行、引用符の数が合わない行。**動詞が動くのは、二つのセットで一致の規則が違うときだけ**です。`he → they` は `he is` を変え、`he → she` は変えません。`--verify` は、代名詞とその動詞以外に何も動いていないことを行ごとに証明します。

詳しい規則は上の英語の節にあります。

## 한국어

**한 대명사 세트를 다른 세트로 바꾸되, 추측하지 않습니다.** `he/him` 을 `they/them` 으로, `she/her` 로, 또는 다시 `he/him` 으로. 직접 만든 세트는 다섯 형태로 적습니다 — **주격 / 목적격 / 소유격 / 소유대명사 / 재귀**, 복수 동사를 쓰면 `:plural` 을 붙입니다.

```bash
node pronoun-sweep.mjs --list-pronouns                        # 기본 제공 세트
node pronoun-sweep.mjs ./notes --from he --to they            # 미리보기만
node pronoun-sweep.mjs ./notes --from he --to she             # 동사는 그대로
node pronoun-sweep.mjs ./notes --from he --to "xe/xem/xyr/xyrs/xemself"
```

따옴표 안의 문장, 코드 블록, `인라인 코드` 는 한 글자도 건드리지 않습니다. 판단이 필요한 줄은 보고만 합니다: 다른 사람의 이름(`--others`), 모호한 축약형, 동사 일치가 필요한 줄, 따옴표 개수가 맞지 않는 줄. **동사가 움직이는 것은 두 세트의 일치 규칙이 다를 때뿐**입니다. `he → they` 는 `he is` 를 바꾸고, `he → she` 는 바꾸지 않습니다. `--verify` 는 대명사와 그 동사 말고 아무것도 움직이지 않았음을 줄마다 증명합니다.

자세한 규칙은 위의 영어 절에 있습니다.

## Credits

**The role bug is Carrious's.** In [issue #1](https://github.com/Toxx-dev/pronoun-sweep/issues/1) they reported that `she → they` turned `she lost her book` into `they lost them book`, and that `it → they` turned `the dog dropped it` into `the dog dropped they` — and that `--verify` certified both as clean.

The report came with the diagnosis and the shape of the fix: that the rules ran in a fixed order so one form swallowed the other, that the context check saving `his` only fired for a set that reuses one word as both possessive forms, and that the proof collapsed every pronoun to a single token and so could never see which form had landed. It then suggested the two things this version does — disambiguate by context, and carry the grammatical slot into the canonical form so the proof can fail.

The role classifier, the one-pass rewrite and the role-bearing canonical form all come from that report. Written up by Keel (Claude) at Carrious's request.

## License

MIT. Take it, change it, ship it.
