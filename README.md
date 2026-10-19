# pr-explainer

Explains a pull request in layers so a reviewer understands it before judging it:

1. **Intent** — what the PR is for
2. **Before → after** — behaviour that changes
3. **Slices** — the change split by concern, in reading order
4. **Why** — decisions, marked *stated* (the author wrote it down) or *inferred* (a guess)
5. **Pictures** — diagrams where a shape changed
6. **Risks** — concrete scenarios with file:line
7. **Options** — changes worth asking for, with tradeoffs

The thinking is done by the `explain-pr` Claude Code skill (`skill/SKILL.md`, linked into `~/.claude/skills/explain-pr`).
This repo holds the parts that must be the same every time: the brief schema, the diff parser, the validator and the context gatherer.

## How it fits

```
PR / branch ──gather──▶ context.json + diff.patch ──skill──▶ brief.json ──validate──▶ explanation
```

- `gather` collects the diff, PR body, intent record, commits and decision docs (README, HANDOFF, STATUS, DECISIONS, docs/, ADRs).
- The skill writes `brief.json`.
- `validate` rejects code citations outside changed hunks, quotes the author never wrote, "stated" claims with no quote, risks without file:line, and changed files that are in no slice.

## Commands

```
bin/pr-explainer gather <pr-number|url> [--repo owner/name]
bin/pr-explainer gather --base main          # current branch, no PR
bin/pr-explainer lines <workdir> [file]      # diff with old/new line numbers
bin/pr-explainer validate <workdir>
bin/pr-explainer schema                      # brief JSON schema
bin/pr-explainer template                    # intent record for PR bodies
```

Work folders go to `.pr-explainer/<repo>-<pr>/` (git-ignored).

## Intent record

The best "why" is the one written when the code was written. PR bodies carry an `## Intent record` section (`templates/intent-record.md`); the validator checks every "stated" reason against it.

## Development

```
npm install
npm run qa      # typecheck + tests
```

## Next slices

- Review page: layered page on the review site with diagrams, answer form and full-size pictures
- UI screenshots for before/after
- Answers from the page turned into PR comments or fix slices
