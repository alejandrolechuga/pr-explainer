---
name: explain-pr
description: Explain a pull request to the user — three sentences first, then the PR one commit (step) at a time, then deeper layers on request (before→after, why each decision was made, stated vs guessed, pictures, what could go wrong, what could change). Builds a checked brief with the pr-explainer CLI. Use when the user says "explain this PR", "explain PR 12", "what does this PR do", "walk me through this PR", "help me understand this change", or invokes /explain-pr. Not a bug hunt; for that use /code-review.
---

# Explain a PR

Goal: the reader understands what a PR is for and what it changes **before** judging it, without reading everything at once.
The page opens with three sentences, then walks the PR step by step (its commits, in order), and keeps every deeper layer closed behind a question.

Tool: the `pr-explainer` command (call it `PE` below; install: see the pr-explainer README). Run it from inside the target repo. If it is not on PATH, stop and tell the user how to install it.

## 1. Gather

- PR: `PE gather <number|url>` (add `--repo owner/name` when not inside the repo).
- No PR yet: `PE gather --base main` on the current branch.

It prints the work folder (with `context.json`, `diff.patch`, and `commits/<sha>.patch` for each commit), whether an intent record was found, and the commits oldest first.

If `issue refs` lists tracker keys (e.g. ABC-123) and an issue-tracker tool is available (Linear, Jira, GitHub issues via `gh`), fetch each and add it to `context.json` → `issues: [{ id, title, body }]` so quotes from it can be checked.

## 2. Read

- Read `context.json` (PR body, intent record, commits, decision docs) **before** the diff, so you read the code knowing what it was meant to do.
- Read the diff with line numbers: `PE lines <workdir> > <workdir>/lines.txt`, then read that file (or `PE lines <workdir> <file>` for one file). Left column = old line, right = new line; cite those numbers. For a step, read its own commit: `PE lines <workdir> --commit <sha>`; a step's citations use **that commit's** line numbers. For a big diff (over ~2,000 changed lines) go file by file; open surrounding code in the repo when a hunk makes no sense alone.

## 3. Write `brief.json` in the work folder

Shape: `PE schema`. Rules:

- **Plain words.** Write for someone who did not see the code. No invented terms. Short sentences.
- **glance** (the first screen, three sentences): `does` what the PR does; `forUser` what is different for the user or the system; `lookAt` the one thing the reader should check. One sentence each, no jargon. This is what the reader sees first; make it count.
- **steps**: the commits as a sequence, oldest first.
  - One step per commit. Fold fix-up commits ("fix typo", "wip", "address review") into the step they fix.
  - `summary`: one or two sentences. `why`: only when a commit message, the intent record or a doc says it; then `basis: "stated"` with the quote (`source: "commit", ref: <sha>`). Otherwise leave `why` out or mark it inferred.
  - `uses`: the earlier steps this one builds on (a function added in step 1 and called in step 3 → step 3 uses step 1). This is how the page connects the sequence.
  - `evidence`: one to three code citations that show the heart of the step, numbered as in that commit's diff.
  - A commit message that says one thing while its code does another is a **mismatch** (quote the commit).
  - Leave `steps` empty when the history cannot be read as a sequence: one commit, or commits that mix unrelated changes or undo each other. The page then shows the slices one at a time instead.
- **intent.summary**: one paragraph, what the PR is for and who notices.
- **beforeAfter**: behaviour per area, as the user or the system experiences it, not "function X changed".
- **slices**: group changed files by concern (not by folder). Every changed file in exactly one slice where possible; `readOrder` 1 = read first (usually the core idea, then its callers, then tests and cleanup). Risk per slice.
- **decisions**: the choices that shaped the PR. `basis: "stated"` ONLY when the author wrote the reason down; then add a `source` citation with an exact quote (intent record, PR body, commit, issue, doc, or `code-comment` for a comment the PR adds). Otherwise `basis: "inferred"` — it will be shown as a guess. Never upgrade a guess to "stated" to pass the check.
- **mismatches**: places where the code does something other than what the intent record, PR body or issue says. These are the most useful findings; look for them on purpose.
- **visuals**: add a Mermaid diagram only when a shape changed (flow, data, structure, states, sequence). Give `before` too when the old shape differs. Skip when a picture adds nothing. Pages are read on phones: draw top to bottom (`flowchart TD`), keep labels short, break lines with `<br/>` (not `\n`), and keep it under ~12 boxes.
- **risks**: concrete scenario ("when X, then Y breaks"), severity, and at least one `code` citation inside a changed hunk. Trace each one through the code before writing it; a risk you have not traced is not a risk, leave it out.
- **options**: changes the reader could ask for, each with its tradeoff, linked to risk/decision ids.
- Code citations: `{ "kind": "code", "file", "side": "new"|"old", "line" }` — `new` for lines after the change, `old` for removed lines. Lines must sit inside a changed hunk.

## 4. Check

`PE validate <workdir>` — fix every ERROR and re-run until it prints no errors. Warnings may stay; mention them if they matter (for example "no intent record, the whys are guesses").

## 4b. Test each step (when you trust the PR)

When the PR's commits are steps and the code comes from the user or someone they trust, run the tests at every commit:

`PE test-steps <workdir> --cmd "<test command>" [--setup "<install command>"]` from inside the repo (or `--dir <repo>`).

- Pick the command the repo itself uses (for Node, the `test` or `qa` script in `package.json`, e.g. `npm test`; `--setup "npm ci"`). Keep it to tests that need no network or secrets.
- It checks each commit out in a throwaway worktree, so the user's working copy is not touched. It runs the PR's code on this computer: never run it on a stranger's PR.
- Skip it when the repo has no tests or they take more than a few minutes per commit; say so in the reply.
- The page then shows pass/fail per step, and a failing step shows why. A step that fails while later ones pass is worth one line in your reply.

## 5. Build the review page

Pick one (it refuses a brief that fails validation):

- The user's settings have a `publishCommand`: `PE render <workdir> --publish` — prints the page address.
- Otherwise: `PE serve <workdir>` **in the background** — opens the page on this computer at http://127.0.0.1:7700/ and saves what they Send next to it.
- Just a file: `PE render <workdir> --open`.
 The page shows the three sentences and where to look, then one step at a time (Looks good / Question / Change it on each, Looks good moves on), then "Tell me more" questions that open the deeper layers, then a verdict and Send (if a receiver is set) or Copy as text. A "Change it" on a step means "fix from this step on".

A newer version of the PR (new commits after a review) gets a new page (`--form-id <name>-v2`). In the same browser, steps whose code did not change keep the reader's marks, and changed or new steps are tagged and asked again, so the reader only rereads what changed.

Before handing it over, open it at phone width (390px) and look: diagrams readable, nothing cut off. Fix the brief and render again if not.

## 6. Tell the reader

In chat, keep it short, top layer first:

1. The page link (or file path).
2. The three glance sentences. Say if there is no intent record.
3. **Steps** — one line each, in order.
4. The one risk that matters most, if any is high or medium.

Then stop. The rest is on the page, and the reader can ask you anything about any step.

## 7. Read the feedback

When the reader says they sent it: `PE answers <workdir>` (reads what `serve` saved, or the `answersFile` in settings), or ask them to paste the copied text. Answer each Question; for each Change it, say what you would change and wait for the go-ahead before editing anything.
