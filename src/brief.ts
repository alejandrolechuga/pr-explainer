// The brief: one structured explanation of a PR. Every page and lens renders from it.
import { z } from "zod";

export const Basis = z.enum(["stated", "inferred"]).describe(
  "stated = the author wrote it down (intent record, PR body, commit, issue, doc) and a quote proves it; inferred = our reading of the code, shown as a guess",
);

export const SourceName = z.enum(["intent-record", "pr-body", "commit", "issue", "doc", "code-comment"]).describe(
  "code-comment = words the PR itself adds (a comment or doc line on a + line of the diff)",
);

export const CodeCitation = z.object({
  kind: z.literal("code"),
  file: z.string().min(1),
  side: z.enum(["new", "old"]).default("new").describe("new = after the change, old = before"),
  line: z.number().int().positive(),
  endLine: z.number().int().positive().optional(),
});

export const SourceCitation = z.object({
  kind: z.literal("source"),
  source: SourceName,
  quote: z.string().min(3).describe("Exact words copied from the source (whitespace and case are ignored when checking)"),
  ref: z.string().optional().describe("Commit sha prefix or doc path when the source has several entries"),
});

export const Citation = z.discriminatedUnion("kind", [CodeCitation, SourceCitation]);
const Evidence = z.array(Citation).min(1);

export const Risk = z.enum(["low", "medium", "high"]);

/** One step of the PR, made of one or more of its commits, read in order. */
export const Step = z.object({
  id: z.string().min(1),
  title: z.string().describe("What this step does, in a few words"),
  summary: z.string().describe("One or two plain sentences: what this step changes"),
  why: z.string().optional().describe("Why this step is needed or done this way"),
  basis: Basis,
  commits: z.array(z.string().min(7)).min(1).describe("Sha prefixes (7+ characters) of the commits in this step, oldest first; fix-up commits join the step they fix"),
  uses: z.array(z.string()).default([]).describe("Ids of earlier steps this one builds on"),
  evidence: z.array(Citation).default([]).describe("Code citations use this step's own commit diffs (line numbers as of that commit); quotes as usual"),
});

/** The first screen: three sentences, nothing more. */
export const Glance = z.object({
  does: z.string().min(5).describe("What the PR does, one sentence"),
  forUser: z.string().min(5).describe("What is different for the user or the system, one sentence"),
  lookAt: z.string().min(5).describe("The one thing the reader should check, one sentence"),
});

export const BriefSchema = z.object({
  version: z.literal(1),
  pr: z.object({
    repo: z.string(),
    number: z.number().int().optional(),
    title: z.string(),
    base: z.string(),
    head: z.string(),
    url: z.string().optional(),
  }),
  glance: Glance.optional(),
  steps: z.array(Step).default([]).describe("The PR's commits as steps in order; empty when the history is too messy to follow"),
  intent: z.object({
    summary: z.string().min(10).describe("One plain-language paragraph: what this PR is for"),
    basis: Basis,
    evidence: Evidence,
  }),
  beforeAfter: z.array(z.object({
    area: z.string().describe("Feature or behaviour area, in user words"),
    before: z.string(),
    after: z.string(),
    evidence: Evidence,
  })).min(1),
  slices: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    summary: z.string(),
    files: z.array(z.string()).min(1),
    risk: Risk,
    readOrder: z.number().int().positive().describe("Suggested order for reading slices, 1 first"),
  })).min(1),
  decisions: z.array(z.object({
    id: z.string().min(1),
    decision: z.string(),
    why: z.string(),
    basis: Basis,
    alternatives: z.array(z.string()).default([]),
    evidence: Evidence,
  })),
  visuals: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    kind: z.enum(["flow", "data", "structure", "sequence", "state", "ui"]),
    caption: z.string(),
    before: z.string().optional().describe("Mermaid source for the old shape, when the shape changed"),
    after: z.string().describe("Mermaid source for the new shape"),
  })).default([]),
  mismatches: z.array(z.object({
    claim: z.string().describe("What the author said would happen"),
    observed: z.string().describe("What the code does instead"),
    evidence: Evidence,
  })).default([]),
  risks: z.array(z.object({
    id: z.string().min(1),
    title: z.string(),
    scenario: z.string().describe("Concrete inputs or state, then what goes wrong"),
    severity: Risk,
    evidence: Evidence,
  })),
  options: z.array(z.object({
    id: z.string().min(1),
    change: z.string(),
    tradeoff: z.string(),
    relatesTo: z.array(z.string()).default([]).describe("Ids of risks or decisions this option answers"),
  })),
});

export type Brief = z.infer<typeof BriefSchema>;
export type CitationT = z.infer<typeof Citation>;
export type StepT = z.infer<typeof Step>;

export function briefJsonSchema(): unknown {
  return z.toJSONSchema(BriefSchema, { io: "input" });
}
