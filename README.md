# pr-explainer

Understand a pull request before you judge it.

`pr-explainer` and its Claude Code skill `/explain-pr` explain a PR a little at a time:

- **Three sentences first** — what it does, what is different for the user, what to check.
- **Then step by step** — each commit is a step, read in order, with how the steps connect ("builds on step 1"). Approve each step as you go.
- **Then, only if you ask**, the deeper layers:

1. **Intent** — what the PR is for
2. **Before → after** — behaviour that changes
3. **Slices** — the change split by concern, in reading order
4. **Why** — each decision, marked *stated* (the author wrote it down) or *inferred* (a guess)
5. **Pictures** — diagrams where a shape changed
6. **Risks** — concrete "when X, then Y breaks" scenarios with file:line
7. **Options** — changes worth asking for, with their tradeoffs

It is not a bug hunter. It is for the moment a PR is too big, too unfamiliar, or too old to just read.

## How it works

```
PR or branch ──gather──▶ context.json + diff.patch + commits/ ──skill──▶ brief.json ──validate──▶ explanation
```

- **gather** collects the diff, PR body, intent record, commits, issue keys and decision docs (README, CONTEXT, HANDOFF, STATUS, DECISIONS, `docs/`, ADRs).
- **The skill** (Claude) reads the context first, then the diff, and writes `brief.json`.
- **validate** keeps the explanation honest. It rejects:
  - code citations outside the changed lines
  - quotes the author never wrote
  - "stated" reasons with no quote behind them
  - risks without a file:line
  - changed files that no slice covers
  - commits that are in no step, or steps that cite lines their own commit did not change

The thinking needs judgment, so it lives in the skill. The checking must give the same answer every time, so it lives here.

## Install

Needs Node 20+, git, and the GitHub CLI (`gh`, signed in) for PRs.

```sh
git clone https://github.com/alejandrolechuga/pr-explainer.git
cd pr-explainer
npm install
npm link                      # puts `pr-explainer` on your PATH
pr-explainer install-skill    # links the skill into ~/.claude/skills/explain-pr
```

Then, in Claude Code inside any repo: `/explain-pr 42`, or "explain this PR".

## Commands

```
pr-explainer gather <pr-number|url> [--repo owner/name]
pr-explainer gather --base main              # current branch, no PR needed
pr-explainer lines <workdir> [file]          # diff with old/new line numbers
pr-explainer validate <workdir> [--json]
pr-explainer render <workdir> [--submit json:<url>|form:<url>] [--form-id <id>] [--publish] [--open]
pr-explainer serve <workdir> [--port 7700]   # the page on this computer; Send saves to <workdir>/answers.jsonl
pr-explainer answers <workdir|form-id>       # feedback sent from the page
pr-explainer schema                          # JSON schema of brief.json
pr-explainer template                        # intent record for PR bodies
pr-explainer install-skill [--dir <path>]
```

Work folders go to `~/.cache/pr-explainer/<repo>-<pr>/` (override with `PR_EXPLAINER_HOME`).

## The review page

`render` writes `<workdir>/page/index.html`: one self-contained page you can open in any browser (`--open` does it for you) (diagrams drawn with Mermaid from a CDN) that works on a phone. It opens with three sentences and the risks worth a look, then shows the PR one step at a time: a strip of numbered steps, and for the current step what it does, why, which steps it builds on, and its code as that commit changed it. **Looks good** moves to the next step; **Change it** means "fix from this step on". Everything else (before → after, why, pictures, plan vs code, risks, options, files) sits closed under "Tell me more". Code is shown with added lines green, removed red, cited lines in bold, and a link to the same lines on GitHub. The reader picks a verdict and sends it or copies it as text. A draft, and the step being read, are kept in the browser until sent.

When a PR's commits don't read as a sequence (one commit, or a messy history), the page walks through its slices instead, one part at a time.

### Commits as steps

The step view works best when each commit is one idea that leaves the code working, with a message that says what and why. The intent record template (`pr-explainer template`) has a Steps list for the same sequence.

Nothing to host? `pr-explainer serve <workdir>` shows the page at http://127.0.0.1:7700/ and Send saves the review to `<workdir>/answers.jsonl`, which `pr-explainer answers` reads.

To host it yourself, sending is up to you:

- `json:<url>` — POSTs `{ page, answers, comment, items }` (CORS is the receiver's job)
- `form:<url>` — submits a plain form with `id`, `answer` (the verdict) and `note` (the whole review as text)
- nothing — Copy as text only

## Settings

Personal settings live outside the repo, in `~/.config/pr-explainer/config.json` (or `$PR_EXPLAINER_CONFIG`):

```json
{
  "submit": "json:https://example.com/feedback",
  "formIdPrefix": "pr-",
  "noteLimit": 4000,
  "answersFile": "~/reviews/answers.jsonl",
  "publishCommand": "rsync -a {dir}/ me@host:/var/www/reviews/{name}/ && echo https://host/reviews/{name}/"
}
```

`publishCommand` runs after `render --publish`, with `{name}` (feedback id), `{dir}` and `{file}` filled in and shell-quoted. `answersFile` is a JSON-lines file your receiver appends to; entries whose `id` or `page` matches the feedback id are shown by `answers`.

## Intent records

The most accurate "why" is the one written when the code was written. Add an `## Intent record` section to PR bodies (`pr-explainer template`): goal, before/after, decisions with rejected alternatives, shortcuts, linked issue. The validator checks every "stated" reason against it.

To have Claude Code write one on every PR, add this to your `CLAUDE.md`:

```md
When opening a PR, put an `## Intent record` section in the body (`pr-explainer template`),
written from what was actually decided; never invent reasons after the fact.
```

## Development

```sh
npm install
npm run qa      # typecheck, tests, and a browser run of the review page (needs Chrome; CHROME_PATH to point at it)
```

## Roadmap

- Before/after screenshots for UI changes
- Feedback from the page turned into PR review comments

## License

MIT
