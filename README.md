# pr-explainer

Understand a pull request before you judge it.

`pr-explainer` and its Claude Code skill `/explain-pr` explain a PR in layers, from the big picture down:

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
PR or branch ──gather──▶ context.json + diff.patch ──skill──▶ brief.json ──validate──▶ explanation
```

- **gather** collects the diff, PR body, intent record, commits, issue keys and decision docs (README, CONTEXT, HANDOFF, STATUS, DECISIONS, `docs/`, ADRs).
- **The skill** (Claude) reads the context first, then the diff, and writes `brief.json`.
- **validate** keeps the explanation honest. It rejects:
  - code citations outside the changed lines
  - quotes the author never wrote
  - "stated" reasons with no quote behind them
  - risks without a file:line
  - changed files that no slice covers

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
pr-explainer schema                          # JSON schema of brief.json
pr-explainer template                        # intent record for PR bodies
pr-explainer install-skill [--dir <path>]
```

Work folders go to `~/.cache/pr-explainer/<repo>-<pr>/` (override with `PR_EXPLAINER_HOME`).

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
npm run qa      # typecheck + tests
```

## Roadmap

- Review page: the layers as a web page, with rendered diagrams and a feedback form
- Before/after screenshots for UI changes
- Feedback from the page turned into PR review comments

## License

MIT
