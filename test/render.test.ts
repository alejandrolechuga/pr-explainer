import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { BriefSchema } from "../src/brief.js";
import { readCommitDiffs } from "../src/commits.js";
import type { PrContext } from "../src/context.js";
import { parseDiff } from "../src/diff.js";
import { esc, fileAnchor, formIdFor, renderPage } from "../src/render.js";

const dir = new URL("./fixtures/workdir/", import.meta.url);
const ctx = JSON.parse(readFileSync(new URL("context.json", dir), "utf8")) as PrContext;
const diffText = readFileSync(new URL("diff.patch", dir), "utf8");
const files = parseDiff(diffText);
const brief = BriefSchema.parse(JSON.parse(readFileSync(new URL("brief.json", dir), "utf8")));
const commitDiffs = readCommitDiffs(fileURLToPath(dir), ctx);
const page = (over: Partial<typeof brief> = {}, submit?: string) =>
  renderPage({ ...brief, ...over }, ctx, files, { formId: "pr-shop-7", diffText, commitDiffs, ...(submit ? { submit } : {}) });

describe("renderPage", () => {
  it("escapes everything that comes from the brief", () => {
    const html = page();
    expect(html).toContain("Bulk discount &lt;b&gt;&amp; friends&lt;/b&gt;");
    expect(html).not.toContain("<b>& friends");
    expect(esc(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
  });

  it("cannot be broken out of by the embedded settings", () => {
    const html = renderPage({ ...brief, pr: { ...brief.pr, title: "</script><script>alert(1)</script>" } }, ctx, files, { formId: "x" });
    const cfg = /<script type="application\/json" id="cfg">([^]*?)<\/script>/.exec(html)![1]!;
    expect(cfg).not.toContain("</script");
    expect(JSON.parse(cfg).title).toBe("</script><script>alert(1)</script>");
  });

  it("links files to GitHub's changed-files anchors", () => {
    expect(fileAnchor("src/cart.ts")).toMatch(/^diff-[0-9a-f]{64}$/);
    expect(page()).toContain(`https://github.com/example/shop/pull/7/files#${fileAnchor("src/cart.ts")}R14-R16`);
    expect(renderPage(brief, ctx, files, { formId: "x" })).toContain(`files#${fileAnchor("src/cart.ts")}R14-R16`);
  });

  it("has no links without a PR address", () => {
    const html = renderPage(brief, { ...ctx, pr: { ...ctx.pr, url: undefined } as PrContext["pr"] }, files, { formId: "x" });
    expect(html).not.toContain('class="cite" href');
  });

  it("says so when a layer is empty", () => {
    const html = page({ mismatches: [], risks: [], options: [], visuals: [], decisions: [] });
    expect(html).toContain("No differences found between what the PR says it does and what the code does.");
    expect(html).toContain("Nothing found that is likely to go wrong.");
    expect(html).toContain("No diagrams");
  });

  it("warns when there is no intent record", () => {
    const html = renderPage(brief, { ...ctx, intentRecord: null }, files, { formId: "x" });
    expect(html).toContain("No intent record");
  });

  it("shows Send only with a receiver", () => {
    expect(page()).not.toContain('id="send"');
    expect(page({}, "json:https://example.test/feedback")).toContain('id="send"');
  });

  it("puts a feedback control on every item", () => {
    const html = page();
    const n = brief.steps.length + brief.decisions.length + brief.visuals.length + brief.mismatches.length + brief.risks.length + brief.options.length;
    expect(html.match(/class="fb"/g)?.length).toBe(n);
  });
});

describe("code on the page", () => {
  it("shows the cited lines, escaped, with the cited ones marked", () => {
    const html = page();
    expect(html).toContain('<tr class="row-add hit"><td class="ln">12</td><td class="mk">+</td><td class="tx">    sum += i.<span class="hljs-property">price</span> * i.<span class="hljs-property">qty</span>;</td></tr>');
    expect(html).toContain('<tr class="row-del"><td class="ln">12</td>');
    expect(html).toMatch(/src\/cart\.ts:14–16<\/span><a href="https:\/\/github\.com\/example\/shop\/pull\/7\/files#diff-[0-9a-f]{64}R14-R16"/);
  });

  it("code text keeps the page's ink colour, not the +/− counter colour", () => {
    const css = /<style>([^]*?)<\/style>/.exec(page())![1]!;
    expect(css).not.toMatch(/\.code tr\.(add|del)\b/);
    expect(page()).not.toMatch(/<tr class="(add|del)[ "]/);
  });

  it("colours an excerpt that starts inside a comment as a comment", () => {
    const lines = ["/* one", " two", " three", " four", " five", " six", " seven", " eight */", "const x = 1;"];
    const d = `diff --git a/src/c.ts b/src/c.ts\nnew file mode 100644\n--- /dev/null\n+++ b/src/c.ts\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}\n`;
    const f = parseDiff(d);
    const b = { ...brief, risks: [{ id: "r", title: "t", scenario: "s", severity: "low" as const, evidence: [{ kind: "code" as const, file: "src/c.ts", side: "new" as const, line: 7 }] }] };
    const html = renderPage(b, ctx, f, { formId: "x", diffText: d });
    expect(html).toContain('<td class="ln">7</td><td class="mk">+</td><td class="tx"><span class="hljs-comment"> seven</span>');
  });

  it("falls back to a plain reference when there is no code to show", () => {
    const html = renderPage(brief, ctx, files, { formId: "x" });
    expect(html).not.toContain('class="snip"');
    expect(html).toContain('class="cite"');
  });
});

describe("the first screen and the steps", () => {
  it("starts with three sentences, then the steps, then closed layers", () => {
    const html = page();
    const at = (s: string) => html.indexOf(s);
    expect(at('class="g-does"')).toBeGreaterThan(0);
    expect(at('class="g-does"')).toBeLessThan(at('id="steps"'));
    expect(at('id="steps"')).toBeLessThan(at("Tell me more"));
    expect(html).not.toMatch(/<details class="layer"[^>]* open/);
    expect(html).toContain("Cart totals now count quantity");
    expect(html).toContain('<a href="#risk-r-drift">Constants drift from the code</a>');
  });

  it("shows the commits as steps, in order, the first one visible", () => {
    const html = page();
    const ids = [...html.matchAll(/<article class="step" id="step-([^"]+)" data-step="[^"]+"( hidden)?/g)].map((m) => [m[1], !!m[2]]);
    expect(ids).toEqual([["st-qty", false], ["st-discount", true], ["st-cleanup", true]]);
    expect(html).toContain("<b>Step 2 of 3</b>");
    expect(html).toContain('Builds on <a href="#step-st-qty" data-go="st-qty">step 1</a>.');
    expect(html).toContain('Later, <a href="#step-st-discount" data-go="st-discount">step 2</a> relies on this.');
  });

  it("shows a step's code as its own commit changed it, linked to that commit", () => {
    const html = page();
    expect(html).toMatch(/https:\/\/github\.com\/example\/shop\/pull\/7\/commits\/bbb2222bbbb#diff-[0-9a-f]{64}R14-R16/);
    expect(html).toContain('<a href="https://github.com/example/shop/pull/7/commits/aaa1111aaaa"');
  });

  it("shows a multi-commit step's code from the commit that changed it", () => {
    const html = page({ steps: [{ ...brief.steps[0]!, commits: ["aaa1111", "bbb2222"], evidence: [{ kind: "code", file: "src/cart.ts", side: "new", line: 14, endLine: 16 }] }, brief.steps[2]!] });
    expect(html).toMatch(/commits\/bbb2222bbbb#diff-[0-9a-f]{64}R14-R16/);
  });

  it("uses the slices as parts when there are no steps", () => {
    const html = page({ steps: [] });
    expect(html).toContain("Part by part");
    expect(html).toContain('id="step-s-total"');
    expect(html).toContain("do not read as steps");
  });
});

describe("formIdFor", () => {
  it("makes a safe id from the repo and PR", () => {
    expect(formIdFor(ctx)).toBe("pr-shop-7");
    expect(formIdFor({ ...ctx, repo: "Org/My_Repo", pr: { ...ctx.pr, number: undefined, head: "feature/X" } }, "review-")).toBe("review-my-repo-feature-x");
  });
});
