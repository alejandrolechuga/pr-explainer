// Checks a brief against the diff and the context, so explanations cannot cite things that are not there.
import { BriefSchema, type Brief, type CitationT } from "./brief.js";
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

/** `diffText`: the raw diff, so "code-comment" quotes can be checked against its added lines. */
export function validateBrief(raw: unknown, files: DiffFile[], ctx: PrContext, diffText = ""): Report {
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
  const byOldPath = new Map(files.map((f) => [f.oldPath, f] as const));

  const checkCitation = (where: string, c: CitationT) => {
    if (c.kind === "code") {
      const f = c.side === "old" ? byOldPath.get(c.file) ?? byPath.get(c.file) : byPath.get(c.file);
      if (!f) {
        warn(where, `${c.file} is not in this PR's diff; the citation cannot be checked`);
        return;
      }
      const last = c.endLine ?? c.line;
      if (last < c.line) err(where, `${c.file}: endLine ${last} is before line ${c.line}`);
      for (const n of c.endLine && c.endLine !== c.line ? [c.line, c.endLine] : [c.line]) {
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

  const checkClaim = (where: string, basis: "stated" | "inferred" | null, evidence: CitationT[]) => {
    evidence.forEach((c, i) => checkCitation(`${where}.evidence[${i}]`, c));
    if (basis === "stated" && !evidence.some((c) => c.kind === "source")) {
      err(where, `marked "stated" but has no quote from the author's words; mark it "inferred" or add a source quote`);
    }
  };

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
