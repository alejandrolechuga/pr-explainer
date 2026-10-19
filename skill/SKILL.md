---
name: explain-pr
description: Explain a pull request to the user in layers — intent first, then before→after, slices in reading order, why each decision was made (stated vs guessed), pictures, what could go wrong, and what could change. Builds a checked brief with the pr-explainer CLI. Use when the user says "explain this PR", "explain PR 12", "what does this PR do", "walk me through this PR", "help me understand this change", or invokes /explain-pr. Not a bug hunt; for that use /code-review.
---

# Explain a PR

Goal: the reader understands what a PR is for and what it changes **before** judging it.
Order matters: intent → before/after → slices → why → pictures → risks → options.

Tool: the `pr-explainer` command (call it `PE` below; install: see the pr-explainer README). Run it from inside the target repo. If it is not on PATH, stop and tell the user how to install it.

## 1. Gather

- PR: `PE gather <number|url>` (add `--repo owner/name` when not inside the repo).
- No PR yet: `PE gather --base main` on the current branch.

It prints the work folder (`.../.pr-explainer/<repo>-<pr>/` with `context.json` and `diff.patch`) and whether an intent record was found.

If `issue refs` lists tracker keys (e.g. ABC-123) and an issue-tracker tool is available (Linear, Jira, GitHub issues via `gh`), fetch each and add it to `context.json` → `issues: [{ id, title, body }]` so quotes from it can be checked.

## 2. Read

- Read `context.json` (PR body, intent record, commits, decision docs) **before** the diff, so you read the code knowing what it was meant to do.
- Read the diff with line numbers: `PE lines <workdir> > <workdir>/lines.txt`, then read that file (or `PE lines <workdir> <file>` for one file). Left column = old line, right = new line; cite those numbers. For a big diff (over ~2,000 changed lines) go file by file; open surrounding code in the repo when a hunk makes no sense alone.

## 3. Write `brief.json` in the work folder

Shape: `PE schema`. Rules:

- **Plain words.** Write for someone who did not see the code. No invented terms. Short sentences.
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

## 5. Build the review page

`PE render <workdir>` (add `--publish` when the user's settings have a `publishCommand`; it prints the page address). It refuses a brief that fails validation. The page shows every layer, draws the diagrams, and lets the reader mark each item OK / Question / Change it, pick a verdict, and Send (if a receiver is set) or Copy as text.

Before handing it over, open it at phone width (390px) and look: diagrams readable, nothing cut off. Fix the brief and render again if not.

## 6. Tell the reader

In chat, keep it short, top layer first:

1. The page link (or file path).
2. **In 30 seconds** — intent paragraph + 2–4 before→after lines. Say if there is no intent record.
3. **Reading map** — slices in read order, one line each.
4. The one or two risks that matter most, if any are high or medium.

Then stop. The rest is on the page.

## 7. Read the feedback

When the reader says they sent it: `PE answers <workdir>` (needs `answersFile` in settings), or ask them to paste the copied text. Answer each Question; for each Change it, say what you would change and wait for the go-ahead before editing anything.
