import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BriefSchema } from "../src/brief.js";
import type { PrContext } from "../src/context.js";
import { parseDiff } from "../src/diff.js";
import { esc, fileAnchor, formIdFor, renderPage } from "../src/render.js";

const dir = new URL("./fixtures/workdir/", import.meta.url);
const ctx = JSON.parse(readFileSync(new URL("context.json", dir), "utf8")) as PrContext;
const diffText = readFileSync(new URL("diff.patch", dir), "utf8");
const files = parseDiff(diffText);
const brief = BriefSchema.parse(JSON.parse(readFileSync(new URL("brief.json", dir), "utf8")));
const page = (over: Partial<typeof brief> = {}, submit?: string) =>
  renderPage({ ...brief, ...over }, ctx, files, { formId: "pr-shop-7", diffText, ...(submit ? { submit } : {}) });

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
    expect(html).toContain("This PR has no intent record");
  });

  it("shows Send only with a receiver", () => {
    expect(page()).not.toContain('id="send"');
    expect(page({}, "json:https://example.test/feedback")).toContain('id="send"');
  });

  it("puts a feedback control on every item", () => {
    const html = page();
    const n = brief.slices.length + brief.decisions.length + brief.visuals.length + brief.mismatches.length + brief.risks.length + brief.options.length;
    expect(html.match(/class="fb"/g)?.length).toBe(n);
  });
});

describe("code on the page", () => {
  it("shows the cited lines, escaped, with the cited ones marked", () => {
    const html = page();
    expect(html).toContain('<tr class="add hit"><td class="ln">12</td><td class="mk">+</td><td class="tx">    sum += i.price * i.qty;</td></tr>');
    expect(html).toContain('<tr class="del"><td class="ln">12</td>');
    expect(html).toMatch(/src\/cart\.ts:14–16<\/span><a href="https:\/\/github\.com\/example\/shop\/pull\/7\/files#diff-[0-9a-f]{64}R14-R16"/);
  });

  it("falls back to a plain reference when there is no code to show", () => {
    const html = renderPage(brief, ctx, files, { formId: "x" });
    expect(html).not.toContain('class="snip"');
    expect(html).toContain('class="cite"');
  });
});

describe("formIdFor", () => {
  it("makes a safe id from the repo and PR", () => {
    expect(formIdFor(ctx)).toBe("pr-shop-7");
    expect(formIdFor({ ...ctx, repo: "Org/My_Repo", pr: { ...ctx.pr, number: undefined, head: "feature/X" } }, "review-")).toBe("review-my-repo-feature-x");
  });
});
