// Checks a brief against the diff and the context, so explanations cannot cite things that are not there.
import { BriefSchema, type Brief, type CitationT } from "./brief.js";
import { stepResult, type Checks } from "./checks.js";
import { commitForCitation, fileFor, findCommit, type CommitDiff } from "./commits.js";
import type { PrContext } from "./context.js";
import { lineInDiff, type DiffFile } from "./diff.js";

export interface Finding {
  level: "error" | "warning";
  where: string;
  message: string;
}

export interface Report {
  ok: boolean;
  errors: number;
  warnings: number;
  findings: Finding[];
  brief?: Brief;
}

const norm = (s: string) => s.toLowerCase().replace(/[`*_>]/g, "").replace(/\s+/g, " ").trim();

function sourceTexts(ctx: PrContext, added: string, source: string, ref?: string): string[] {
  switch (source) {
    case "code-comment": return added ? [added] : [];
    case "intent-record": return ctx.intentRecord ? [ctx.intentRecord] : [];
    case "pr-body": return [ctx.body];
    case "commit": return ctx.commits.filter((c) => !ref || c.sha.startsWith(ref)).map((c) => c.message);
    case "issue": return ctx.issues.filter((i) => !ref || i.id === ref).map((i) => `${i.title}\n${i.body}`);
    case "doc": return ctx.docs.filter((d) => !ref || d.path === ref).map((d) => d.text);
    default: return [];
  }
}

/** `diffText`: the raw diff, so "code-comment" quotes can be checked against its added lines.
 *  `commitDiffs`: each commit's own diff, so steps can be checked against their commits. */
export function validateBrief(raw: unknown, files: DiffFile[], ctx: PrContext, diffText = "", commitDiffs: CommitDiff[] = [], checks: Checks | null = null): Report {
  const added = addedText(diffText);
  const findings: Finding[] = [];
  const err = (where: string, message: string) => findings.push({ level: "error", where, message });
  const warn = (where: string, message: string) => findings.push({ level: "warning", where, message });

  const parsed = BriefSchema.safeParse(raw);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) err(issue.path.join(".") || "(root)", issue.message);
    return summarize(findings);
  }
  const brief = parsed.data;
  const byPath = new Map(files.map((f) => [f.path, f] as const));

  /** `step`: the commits a step's code citations must sit in, instead of the PR's diff */
  const checkCitation = (where: string, c: CitationT, step?: CommitDiff[]) => {
    if (c.kind === "code") {
      const last = c.endLine ?? c.line;
      if (last < c.line) { err(where, `${c.file}: endLine ${last} is before line ${c.line}`); return; }
      if (step) {
        if (commitForCitation(step, c)) return;
        const touched = step.some((d) => fileFor(d.files, c.file, c.side));
        err(where, touched ? `${c.file}:${c.line}${last !== c.line ? `-${last}` : ""} (${c.side} side) is outside every hunk of this step's commits` : `${c.file} is not changed by this step's commits`);
        return;
      }
      const f = fileFor(files, c.file, c.side);
      if (!f) {
        warn(where, `${c.file} is not in this PR's diff; the citation cannot be checked`);
        return;
      }
      for (const n of last !== c.line ? [c.line, last] : [c.line]) {
        if (!lineInDiff(f, c.side, n)) err(where, `${c.file}:${n} (${c.side} side) is outside every changed hunk`);
      }
      return;
    }
    const texts = sourceTexts(ctx, added, c.source, c.ref);
    if (!texts.length) {
      err(where, `source "${c.source}"${c.ref ? ` (${c.ref})` : ""} does not exist for this PR`);
      return;
    }
    const q = norm(c.quote);
    if (!texts.some((t) => norm(t).includes(q))) {
      err(where, `quote not found in ${c.source}${c.ref ? ` (${c.ref})` : ""}: "${c.quote.slice(0, 80)}"`);
    }
  };

  const checkClaim = (where: string, basis: "stated" | "inferred" | null, evidence: CitationT[], step?: CommitDiff[]) => {
    evidence.forEach((c, i) => checkCitation(`${where}.evidence[${i}]`, c, step));
    if (basis === "stated" && !evidence.some((c) => c.kind === "source")) {
      err(where, `marked "stated" but has no quote from the author's words; mark it "inferred" or add a source quote`);
    }
  };

  checkSteps(brief, ctx, commitDiffs, checkClaim, err, warn);
  checkTestNotes(brief, ctx, checks, warn);

  checkClaim("intent", brief.intent.basis, brief.intent.evidence);
  if (!ctx.intentRecord) {
    warn("intent", "PR has no intent record; every 'why' in this brief is a guess unless quoted from commits, issue or docs");
  } else if (brief.intent.basis === "inferred") {
    warn("intent", "an intent record exists but the intent is marked inferred; quote it");
  }

  brief.beforeAfter.forEach((b, i) => checkClaim(`beforeAfter[${i}]`, null, b.evidence));
  brief.decisions.forEach((d) => checkClaim(`decisions.${d.id}`, d.basis, d.evidence));
  brief.mismatches.forEach((m, i) => checkClaim(`mismatches[${i}]`, null, m.evidence));
  brief.risks.forEach((r) => {
    checkClaim(`risks.${r.id}`, null, r.evidence);
    if (!r.evidence.some((c) => c.kind === "code")) err(`risks.${r.id}`, "a risk needs at least one file:line citation");
  });

  // Every changed file belongs to a slice; slices only list changed files.
  const covered = new Set<string>();
  for (const s of brief.slices) {
    for (const p of s.files) {
      if (!byPath.has(p)) err(`slices.${s.id}`, `${p} is not a changed file`);
      covered.add(p);
    }
  }
  for (const f of files) if (!covered.has(f.path)) err("slices", `changed file ${f.path} is in no slice`);

  // Ids unique; option links point somewhere.
  const ids = new Map<string, string>();
  const allIds: [string, string][] = [
    ...brief.steps.map((s) => ["steps", s.id] as [string, string]),
    ...brief.slices.map((s) => ["slices", s.id] as [string, string]),
    ...brief.decisions.map((d) => ["decisions", d.id] as [string, string]),
    ...brief.visuals.map((v) => ["visuals", v.id] as [string, string]),
    ...brief.risks.map((r) => ["risks", r.id] as [string, string]),
    ...brief.options.map((o) => ["options", o.id] as [string, string]),
  ];
  for (const [group, id] of allIds) {
    if (ids.has(id)) err(`${group}.${id}`, `id "${id}" is also used in ${ids.get(id)}`);
    else ids.set(id, group);
  }
  for (const o of brief.options) {
    for (const r of o.relatesTo) {
      const g = ids.get(r);
      if (g !== "risks" && g !== "decisions") err(`options.${o.id}`, `relatesTo "${r}" is not a risk or decision id`);
    }
  }
  const orders = brief.slices.map((s) => s.readOrder);
  if (new Set(orders).size !== orders.length) warn("slices", "two slices share a readOrder");

  return summarize(findings, brief);
}

type Say = (where: string, message: string) => void;

/** Steps cover every commit once, in order; each step only cites lines its own commits changed. */
function checkSteps(brief: Brief, ctx: PrContext, commitDiffs: CommitDiff[], checkClaim: (w: string, b: "stated" | "inferred", e: CitationT[], step: CommitDiff[]) => void, err: Say, warn: Say): void {
  const real = ctx.commits.filter((c) => !c.merge);
  if (!brief.steps.length) {
    if (real.length > 1) warn("steps", `the PR has ${real.length} commits but no steps; the page will use the slices instead`);
    return;
  }
  const order = new Map(ctx.commits.map((c, i) => [c.sha, i] as const));
  const owner = new Map<string, string>();
  const seen = new Set<string>();
  let last = -1;
  for (const s of brief.steps) {
    const where = `steps.${s.id}`;
    const shas: string[] = [];
    for (const ref of s.commits) {
      const hit = findCommit(ctx.commits, ref);
      if (typeof hit === "string") { err(where, hit); continue; }
      if (ctx.commits.find((c) => c.sha === hit.sha)?.merge) { err(where, `commit ${ref} is a merge; merges are not steps, leave it out`); continue; }
      if (owner.has(hit.sha)) err(where, `commit ${ref} is already in step ${owner.get(hit.sha)}`);
      owner.set(hit.sha, s.id);
      shas.push(hit.sha);
    }
    if (shas.length) {
      const first = Math.min(...shas.map((x) => order.get(x) ?? 0));
      if (first < last) warn(where, "this step's commits come before the previous step's; steps should follow the commit order");
      last = Math.max(last, ...shas.map((x) => order.get(x) ?? 0));
    }
    for (const u of s.uses) {
      if (u === s.id || !seen.has(u)) err(where, `uses "${u}", which is not an earlier step`);
    }
    seen.add(s.id);
    const diffs = commitDiffs.filter((d) => shas.includes(d.sha));
    const missing = shas.filter((x) => !diffs.some((d) => d.sha === x));
    if (missing.length && s.evidence.some((c) => c.kind === "code")) {
      err(where, `no saved diff for commit ${missing.map((x) => x.slice(0, 7)).join(", ")}: run gather again (if GitHub cannot diff it, cite only the step's other commits, or leave steps empty)`);
    }
    checkClaim(where, s.basis, missing.length ? s.evidence.filter((c) => c.kind === "source") : s.evidence, diffs);
  }
  for (const c of real) if (!owner.has(c.sha)) err("steps", `commit ${c.sha.slice(0, 7)} is in no step`);
}

/** A step whose tests fail needs a plain explanation; a note on a step that passes is a mistake. */
function checkTestNotes(brief: Brief, ctx: PrContext, checks: Checks | null, warn: Say): void {
  for (const s of brief.steps) {
    const shas = s.commits.map((p) => ctx.commits.find((c) => c.sha.startsWith(p))?.sha ?? p);
    const result = stepResult(checks, ctx.commits, shas); // the same result the page shows
    const fails = !!result && !result.ok;
    if (fails && !s.testNote) warn(`steps.${s.id}`, "the tests fail at this step: add a testNote saying what broke, in plain words");
    if (!fails && s.testNote) warn(`steps.${s.id}`, result ? "has a testNote but its tests pass at the step's last commit, so the page will not show it" : "has a testNote but its tests were not run (test-steps)");
  }
}

/** the added lines of a diff, joined, with comment markers removed so a quote can span lines */
function addedText(diff: string): string {
  return diff.split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1).replace(/^\s*(\/\/+|\/\*+|\*+\/?|#+|--)\s?/, ""))
    .join("\n");
}

function summarize(findings: Finding[], brief?: Brief): Report {
  const errors = findings.filter((f) => f.level === "error").length;
  return { ok: errors === 0, errors, warnings: findings.length - errors, findings, ...(brief ? { brief } : {}) };
}

export function formatReport(r: Report): string {
  if (!r.findings.length) return "Brief checks out: every citation found, every changed file in a slice.";
  const lines = r.findings
    .sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1))
    .map((f) => `${f.level === "error" ? "ERROR" : "warn "} ${f.where}: ${f.message}`);
  lines.push(`${r.errors} error(s), ${r.warnings} warning(s)`);
  return lines.join("\n");
}
