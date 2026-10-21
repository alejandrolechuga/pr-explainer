import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { commitForCitation, readCommitDiffs } from "../src/commits.js";
import type { PrContext } from "../src/context.js";
import { parseDiff } from "../src/diff.js";
import { validateBrief } from "../src/validate.js";

const files = parseDiff(readFileSync(new URL("./fixtures/sample.patch", import.meta.url), "utf8"));

const ctx: PrContext = {
  version: 1,
  repo: "o/r",
  pr: { number: 1, title: "Bulk discount", base: "main", head: "discount" },
  body: "## Intent record\n**Goal:** Give 10% off orders over $100.",
  intentRecord: "**Goal:** Give 10% off orders over $100.",
  commits: [{ sha: "abc123", message: "Count quantity in cart total" }],
  issueRefs: [],
  issues: [],
  docs: [],
};

const code = (file: string, line: number, side: "new" | "old" = "new") => ({ kind: "code" as const, file, line, side });

function goodBrief() {
  return {
    version: 1,
    pr: { repo: "o/r", number: 1, title: "Bulk discount", base: "main", head: "discount" },
    intent: {
      summary: "Orders over $100 get 10% off, and totals count quantity.",
      basis: "stated",
      evidence: [{ kind: "source", source: "intent-record", quote: "give 10%   off orders over $100" }] as object[],
    },
    beforeAfter: [{ area: "Cart total", before: "Ignored quantity", after: "Price times quantity", evidence: [code("src/cart.ts", 13)] }],
    slices: [
      { id: "s1", title: "Total", summary: "math", files: ["src/cart.ts", "src/new.ts"], risk: "medium", readOrder: 1 },
      { id: "s2", title: "Cleanup", summary: "files", files: ["old.txt", "b/name.ts", "logo.png"], risk: "low", readOrder: 2 },
    ],
    decisions: [{
      id: "d1", decision: "Discount after summing", why: "simpler", basis: "inferred",
      evidence: [code("src/cart.ts", 15)],
    }],
    risks: [{ id: "r1", title: "Constants unused", scenario: "Change DISCOUNT; cart still uses 0.9", severity: "low", evidence: [code("src/new.ts", 1)] }],
    options: [{ id: "o1", change: "Import DISCOUNT in cart", tradeoff: "one more import", relatesTo: ["r1"] }],
  };
}

describe("validateBrief", () => {
  it("passes a brief whose citations all exist", () => {
    const r = validateBrief(goodBrief(), files, ctx);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("reports schema problems with their path", () => {
    const b = goodBrief() as Record<string, unknown>;
    delete b.intent;
    const r = validateBrief(b, files, ctx);
    expect(r.ok).toBe(false);
    expect(r.findings[0]?.where).toBe("intent");
  });

  it("rejects lines outside the changed hunks", () => {
    const b = goodBrief();
    b.beforeAfter[0]!.evidence = [code("src/cart.ts", 40)];
    const r = validateBrief(b, files, ctx);
    expect(r.findings.map((f) => f.message)).toContain("src/cart.ts:40 (new side) is outside every changed hunk");
  });

  it("rejects quotes the author never wrote", () => {
    const b = goodBrief();
    b.intent.evidence = [{ kind: "source", source: "intent-record", quote: "make checkout faster" }];
    const r = validateBrief(b, files, ctx);
    expect(r.errors).toBe(1);
    expect(r.findings[0]?.message).toMatch(/quote not found/);
  });

  it("rejects 'stated' claims that only cite code", () => {
    const b = goodBrief();
    b.decisions[0]!.basis = "stated";
    const r = validateBrief(b, files, ctx);
    expect(r.findings.some((f) => f.where === "decisions.d1" && /no quote/.test(f.message))).toBe(true);
  });

  it("requires every changed file in a slice and only changed files", () => {
    const b = goodBrief();
    b.slices[1]!.files = ["old.txt", "b/name.ts", "nope.ts"];
    const msgs = validateBrief(b, files, ctx).findings.map((f) => f.message);
    expect(msgs).toContain("nope.ts is not a changed file");
    expect(msgs).toContain("changed file logo.png is in no slice");
  });

  it("requires code evidence for risks and valid option links", () => {
    const b = goodBrief();
    b.risks[0]!.evidence = [{ kind: "source", source: "commit", quote: "count quantity" } as never];
    b.options[0]!.relatesTo = ["s1"];
    const msgs = validateBrief(b, files, ctx).findings.map((f) => f.message);
    expect(msgs).toContain("a risk needs at least one file:line citation");
    expect(msgs).toContain('relatesTo "s1" is not a risk or decision id');
  });

  it("warns when there is no intent record", () => {
    const b = goodBrief();
    b.intent.basis = "inferred";
    b.intent.evidence = [code("src/cart.ts", 15)];
    const r = validateBrief(b, files, { ...ctx, intentRecord: null });
    expect(r.ok).toBe(true);
    expect(r.warnings).toBe(1);
  });

  it("accepts old-side citations for deleted lines and renamed files", () => {
    const b = goodBrief();
    b.beforeAfter[0]!.evidence = [code("src/cart.ts", 12, "old"), code("old.txt", 1, "old")];
    expect(validateBrief(b, files, ctx).ok).toBe(true);
  });
});

describe("code-comment quotes", () => {
  const diffText = readFileSync(new URL("./fixtures/sample.patch", import.meta.url), "utf8");
  it("finds words on added lines, and not on removed ones", () => {
    const b = goodBrief();
    b.decisions[0]!.basis = "stated";
    b.decisions[0]!.evidence = [{ kind: "source", source: "code-comment", quote: "sum = sum * 0.9" } as never];
    expect(validateBrief(b, files, ctx, diffText).ok).toBe(true);
    b.decisions[0]!.evidence = [{ kind: "source", source: "code-comment", quote: "sum += i.price;" } as never];
    expect(validateBrief(b, files, ctx, diffText).findings[0]?.message).toMatch(/quote not found in code-comment/);
  });
});

describe("line ranges", () => {
  it("checks both ends of a range", () => {
    const b = goodBrief();
    b.beforeAfter[0]!.evidence = [{ ...code("src/cart.ts", 13), endLine: 30 } as never];
    expect(validateBrief(b, files, ctx).findings.map((f) => f.message)).toEqual(["src/cart.ts:30 (new side) is outside every changed hunk"]);
  });
});

describe("steps", () => {
  const dir = new URL("./fixtures/workdir/", import.meta.url);
  const fctx = JSON.parse(readFileSync(new URL("context.json", dir), "utf8")) as PrContext;
  const fdiff = readFileSync(new URL("diff.patch", dir), "utf8");
  const commitDiffs = readCommitDiffs(fileURLToPath(dir), fctx);
  const fbrief = () => JSON.parse(readFileSync(new URL("brief.json", dir), "utf8")) as { steps: Record<string, unknown>[] };
  const check = (b: unknown, c: PrContext = fctx) => validateBrief(b, parseDiff(fdiff), c, fdiff, commitDiffs);
  const messages = (b: unknown, c?: PrContext) => check(b, c).findings.map((f) => `${f.where}: ${f.message}`).join("\n");

  it("accepts steps that cover every commit in order", () => {
    expect(check(fbrief()).ok).toBe(true);
  });

  it("needs every commit in exactly one step", () => {
    const b = fbrief();
    b.steps.pop();
    expect(messages(b)).toContain("commit ccc3333 is in no step");
    const c = fbrief();
    c.steps[2]!.commits = ["ccc3333", "aaa1111"];
    expect(messages(c)).toContain("commit aaa1111 is already in step st-qty");
  });

  it("rejects commits that are not in the PR", () => {
    const b = fbrief();
    b.steps[2]!.commits = ["fff9999"];
    expect(messages(b)).toContain('"fff9999" is not a commit of this PR');
  });

  it("only lets a step build on earlier steps", () => {
    const b = fbrief();
    b.steps[0]!.uses = ["st-discount"];
    expect(messages(b)).toContain('uses "st-discount", which is not an earlier step');
  });

  it("checks a step's code against its own commits", () => {
    const b = fbrief();
    b.steps[0]!.evidence = [{ kind: "code", file: "src/new.ts", line: 1 }];
    expect(messages(b)).toContain("src/new.ts is not changed by this step's commits");
  });

  it("checks each citation against the commit in the step that changed it", () => {
    const b = fbrief();
    b.steps = [
      { ...b.steps[0], commits: ["aaa1111", "bbb2222"], evidence: [{ kind: "code", file: "src/cart.ts", line: 12 }, { kind: "code", file: "src/cart.ts", line: 14, endLine: 16 }] },
      b.steps[2]!,
    ];
    expect(messages(b)).toBe("");
    expect(commitForCitation(commitDiffs, { kind: "code", file: "src/cart.ts", side: "old", line: 12 })?.sha).toBe("aaa1111aaaa");
    expect(commitForCitation(commitDiffs, { kind: "code", file: "src/cart.ts", side: "new", line: 14, endLine: 16 })?.sha).toBe("bbb2222bbbb");
  });

  it("leaves merge commits out of the steps", () => {
    const withMerge = { ...fctx, commits: [...fctx.commits, { sha: "ddd4444dddd", message: "Merge main", merge: true }] };
    expect(check(fbrief(), withMerge).ok).toBe(true);
    const b = fbrief();
    b.steps[2]!.commits = ["ccc3333", "ddd4444"];
    expect(messages(b, withMerge)).toContain("commit ddd4444 is a merge");
  });

  it("says to gather again when a step's commit has no saved diff", () => {
    const b = fbrief();
    b.steps[1]!.commits = ["bbb2222"];
    const r = validateBrief(b, parseDiff(fdiff), fctx, fdiff, commitDiffs.filter((d) => !d.sha.startsWith("bbb")));
    expect(r.findings.map((f) => f.message).join("\n")).toContain("no saved diff for commit bbb2222");
  });

  it("warns when a PR with several commits has no steps", () => {
    const b = fbrief();
    b.steps = [];
    const r = check(b);
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.where === "steps" && f.level === "warning")).toBe(true);
  });
});
