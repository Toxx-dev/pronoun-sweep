# pronoun-sweep

[![self-test](https://github.com/Toxx-dev/pronoun-sweep/actions/workflows/test.yml/badge.svg)](https://github.com/Toxx-dev/pronoun-sweep/actions/workflows/test.yml)

**Rewrites he/him/his to they/them/their — and refuses to guess.** One file, zero dependencies, offline. Quoted spans and code are copied through byte-identical; anything that needs a judgement call is reported, never rewritten.

```bash
node pronoun-sweep.mjs --self-test
```

```text
pronoun-sweep.mjs v1.0.0 — self-test

  PASS  a bare pronoun swaps
  PASS  the capital keeps its case
  PASS  himself becomes themselves
  PASS  he is becomes they are
  ...
  PASS  --help is an answer, not an error
  PASS  a missing directory is a sentence, not a stack trace

  19/19 passed
```

Then look at what it would do to a folder — **nothing is written until `--commit`**:

```bash
node pronoun-sweep.mjs ./notes --others "Dana"
```

```text
pronoun-sweep v1.0.0 — dry run

root            : notes
files with work : 1
lines AUTO      : 4
lines REVIEW    : 2
  review reasons : agreement 1 · names another person 1
he : they now   : 14 / 0 = INF:1

by file (top 25):
      4 auto      2 review   draft.md
```

Four lines it can defend, two it will not touch. And when it does commit, it proves itself:

```bash
node pronoun-sweep.mjs ./notes --commit
node pronoun-sweep.mjs ./notes --verify .pronoun-sweep
```

```text
verified 1 file(s) · 4 changed line(s)
RESULT: clean — every change is a pronoun or its verb; quotes and code untouched.
```

## Getting it

```bash
git clone https://github.com/Toxx-dev/pronoun-sweep.git
cd pronoun-sweep

node pronoun-sweep.mjs --self-test                  # 19/19
node pronoun-sweep.mjs examples --others "Dana" # dry run on the example that ships
```

Or put it on your PATH and forget about the clone:

```bash
npm install -g github:Toxx-dev/pronoun-sweep
pronoun-sweep ./notes
```

Node 18 or newer. No dependencies.

## Usage

```bash
node pronoun-sweep.mjs [<dir>]                    # dry run: counts, reasons, per file
node pronoun-sweep.mjs [<dir>] --sheet out.md     # dry run, plus a review sheet to read
node pronoun-sweep.mjs [<dir>] --commit           # apply the AUTO lines (backup written first)
node pronoun-sweep.mjs [<dir>] --verify <state>   # prove the backup against the files it came from
node pronoun-sweep.mjs --self-test
node pronoun-sweep.mjs --help
node pronoun-sweep.mjs --version
```

| flag | what it does |
|---|---|
| `--others "Name,Name"` | a name here means another person is being discussed, so the line goes to REVIEW |
| `--skip "dir,dir"` | directories to walk past (always: `.git`, `node_modules`, `.pronoun-sweep`) |
| `--state <dir>` | where the backup and the receipt go (default: `.pronoun-sweep` in the current directory) |
| `--sheet <file>` | write the full before/after list to a markdown file you can read |

**Exit codes.** `0` for a dry run and for a clean verify, and for `--help` and `--version`, because asking a question is not an error. `1` when the self-test fails or `--verify` finds a problem. `2` for a usage error, including a directory that does not exist — you get a sentence, not a stack trace.

## What it changes

Only the pronouns, and the verbs that have to agree with them.

- `he` → `they` · `him` → `them` · `his` → `their` · `himself` → `themselves`, and the capital forms
- `he is` → `they are` · `he was` → `they were` · `he has` → `they have` · `he does` → `they do`
- `he's` → `they're` · `he'd` → `they'd` · `he'll` → `they'll` · `he's been` → `they've been`

It walks `.md` files. Every changed line is recorded in a receipt with its he/they counts before and after, and every original file is copied into a backup first.

## What it refuses

This is the part worth reading, because it is why the tool exists.

- **Quoted spans are byte-identical.** `"..."` and `“...”` keep every word they were given. A person's quote is their words, not yours to correct.
- **Code spans are byte-identical.** `` `he` `` stays `` `he` ``.
- **Metalanguage is never touched.** `he/him` and `she/her` name the pronoun itself; a slash-pair is a label, not prose.
- **A line that names somebody else goes to REVIEW.** Pass their names with `--others`.
- **A contraction goes to REVIEW.** `he's` is ambiguous between *he is* and *he has*, so it is not guessed at.
- **A present-tense verb goes to REVIEW.** `he types` would become `they types`, which is wrong, and the tool will not invent `type` for you.
- **An odd number of quote marks goes to REVIEW.** If the quoting is unbalanced, the tool cannot know what is inside it.

A refused line is still shown in the sheet — with its proposed rewrite — so the decision takes seconds instead of a re-read.

## The proof

`--verify` is the other half of the promise. For every file in the backup it compares line by line against the file on disk:

1. the protected spans must be **identical**, and
2. once pronouns and their verbs are canonicalised, **the rest of the line must be identical**.

So a passing verify says, mechanically: *nothing moved except the pronouns and their verbs.* If a run ever changes a word you wrote, the verify fails and names the line. It is the check the author ran against their own work, shipped so you can run it too.

## What it does not do

- **It is not a find-and-replace**, by design. If you want one, this is the wrong tool.
- **It does not rewrite the ambiguous cases.** Lexical verbs, contractions, quotes that mention other people — those stay for a human. That is a smaller diff than you might want, and it is the diff you can defend.
- **It does not handle Markdown structure.** A `#` heading or a list item is just a line; the prose in it is rewritten like any other line.
- **It does not touch files other than `.md`.** No HTML, no source code, no notebooks.
- **It is not a pronoun detector.** It replaces one specific pattern (he/him/his) that a writer has decided to change. It has no opinion about who anybody is.

## 中文

**把 he/him/his 改成 they/them/their，并且拒绝猜测。** 引号里的句子、代码块和 `行内代码` 一字不动——引用的是别人的话，就不是你来改的。遇到需要人判断的行，它只报告、不改写：提到别人的名字（`--others`）、缩写形式、动词需要随主语变化（`he types` 不能变成 `they types`）、或者引号数量不对称。

```bash
node pronoun-sweep.mjs ./notes                  # 只演练，不写入
node pronoun-sweep.mjs ./notes --commit         # 真正写入，并且先备份
node pronoun-sweep.mjs ./notes --verify .pronoun-sweep   # 证明只改了代词
```

`--verify` 会逐行比对：受保护的片段必须完全相同，去掉代词和动词之后其余文字也必须完全相同。所以它通过时的意思是：**除了代词和它的动词，什么都沒动。** 完整规则见上方英文部分。

## 日本語

**he/him/his を they/them/their に書き換えます。ただし推測はしません。** 引用符の中の文、コードブロック、`インラインコード` は一文字も変えません。引用は相手の言葉であって、直す対象ではないからです。判断が要る行は書き換えず、報告だけします——別の人の名前（`--others`）、短縮形、動詞の一致（`he types` を `they types` にはしません）、引用符の数が合わない行。

```bash
node pronoun-sweep.mjs ./notes                  # 下見のみ、書き込みなし
node pronoun-sweep.mjs ./notes --commit         # 実際に書き込み、必ずバックアップを取る
node pronoun-sweep.mjs ./notes --verify .pronoun-sweep   # 代名詞だけが変わったことを証明する
```

`--verify` は行ごとに照合します。保護された断片が完全に同じであること、そして代名詞とその動詞を取り除けば残りが完全に同じであること。通れば「代名詞とその動詞以外、何も動いていない」という意味になります。詳しい規則は上の英語の節にあります。

## 한국어

**he/him/his 를 they/them/their 로 바꾸되, 추측하지는 않습니다.** 따옴표 안의 문장, 코드 블록, `인라인 코드` 는 한 글자도 건드리지 않습니다. 인용은 그 사람의 말이지 고칠 대상이 아니기 때문입니다. 판단이 필요한 줄은 고치지 않고 보고만 합니다: 다른 사람의 이름(`--others`), 축약형, 동사 일치(`he types` 를 `they types` 로 만들지 않습니다), 따옴표 개수가 맞지 않는 줄.

```bash
node pronoun-sweep.mjs ./notes                  # 미리보기만, 쓰지 않음
node pronoun-sweep.mjs ./notes --commit         # 실제로 쓰고, 반드시 백업을 만듦
node pronoun-sweep.mjs ./notes --verify .pronoun-sweep   # 대명사만 바뀌었음을 증명
```

`--verify` 는 줄마다 대조합니다. 보호된 구간이 완전히 같아야 하고, 대명사와 그 동사를 걷어낸 나머지도 완전히 같아야 합니다. 통과했다면 "대명사와 그 동사 말고는 아무것도 움직이지 않았다"는 뜻입니다. 자세한 규칙은 위의 영어 절에 있습니다.

## License

MIT. Take it, change it, ship it.
