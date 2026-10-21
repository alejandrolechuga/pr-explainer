// Each commit's own diff, kept next to the PR's diff, so a PR can be read one commit (step) at a time.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PrContext } from "./context.js";
import type { CitationT } from "./brief.js";
import { lineInDiff, parseDiff, type DiffFile } from "./diff.js";

export interface CommitDiff {
  sha: string;
  text: string;
  files: DiffFile[];
}

const dirOf = (workdir: string) => join(workdir, "commits");

export function writeCommitDiffs(workdir: string, diffs: { sha: string; diff: string }[]): void {
  mkdirSync(dirOf(workdir), { recursive: true });
  for (const d of diffs) writeFileSync(join(dirOf(workdir), `${d.sha}.patch`), d.diff);
}

/** the commits of the PR that have a saved diff, oldest first */
export function readCommitDiffs(workdir: string, ctx: PrContext): CommitDiff[] {
  return ctx.commits.flatMap((c) => {
    const file = join(dirOf(workdir), `${c.sha}.patch`);
    if (!existsSync(file)) return [];
    const text = readFileSync(file, "utf8");
    return [{ sha: c.sha, text, files: parseDiff(text) }];
  });
}

/** the one commit a sha prefix names, or why it names none */
export function findCommit(commits: { sha: string }[], prefix: string): { sha: string } | string {
  const hits = commits.filter((c) => c.sha.startsWith(prefix));
  if (hits.length === 1) return hits[0]!;
  return hits.length ? `"${prefix}" matches ${hits.length} commits; use more characters` : `"${prefix}" is not a commit of this PR`;
}

/** lines a reader goes through in these commits: a rough "minutes to read" */
export function readingMinutes(changedLines: number): number {
  return Math.max(1, Math.round(changedLines / 40));
}

type CodeCite = Extract<CitationT, { kind: "code" }>;

/** the changed file a code citation names; on the old side a renamed file's old path counts too */
export function fileFor(files: DiffFile[], file: string, side: "new" | "old"): DiffFile | undefined {
  return side === "old" ? files.find((f) => f.oldPath === file) ?? files.find((f) => f.path === file) : files.find((f) => f.path === file);
}

/** the first of these commits that changed every line a citation names, or null */
export function commitForCitation(diffs: CommitDiff[], c: CodeCite): CommitDiff | null {
  const ends = c.endLine && c.endLine !== c.line ? [c.line, c.endLine] : [c.line];
  return diffs.find((d) => { const f = fileFor(d.files, c.file, c.side); return !!f && ends.every((n) => lineInDiff(f, c.side, n)); }) ?? null;
}
