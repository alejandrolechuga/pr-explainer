// Opens a rendered review page in Chrome and uses it like a reviewer would: phone and desktop
// widths, light and dark, diagrams, full-size view, feedback, Send (JSON and form) and Copy.
//   npm run smoke                  the sample PR in test/fixtures/workdir
//   npm run smoke -- <workdir>     screenshots of another brief's page (no sending)
// Needs Google Chrome installed (or CHROME_PATH). Screenshots go to qa-output/.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Page } from "playwright-core";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "qa-output");
mkdirSync(OUT, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
if (!CHROME) throw new Error("Chrome not found; set CHROME_PATH");

const ok = (m: string) => console.log(`✔ ${m}`);
const cli = (...args: string[]) => execFileSync(join(ROOT, "bin", "pr-explainer"), args, { encoding: "utf8", env: { ...process.env, PR_EXPLAINER_CONFIG: "/nonexistent" } });

async function noSideScroll(page: Page, what: string) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(over <= 0, `${what}: page scrolls sideways by ${over}px`);
}

async function openAll(page: Page) {
  await page.evaluate(() => { for (const d of document.querySelectorAll<HTMLDetailsElement>("details.layer")) d.open = true; });
  await page.waitForTimeout(800);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const external = process.argv[2];
  if (external) {
    const dir = resolve(external);
    cli("render", dir);
    const url = `file://${join(dir, "page", "index.html")}`;
    for (const [name, vp, scheme] of [["phone", { width: 390, height: 844 }, "light"], ["phone-dark", { width: 390, height: 844 }, "dark"], ["desktop", { width: 1200, height: 900 }, "light"]] as const) {
      const ctx = await browser.newContext({ viewport: vp, colorScheme: scheme, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto(url);
      await openAll(page);
      await noSideScroll(page, name);
      await page.screenshot({ path: join(OUT, `external-${name}.png`), fullPage: true });
      await ctx.close();
    }
    ok(`screenshots of ${dir} in ${OUT}`);
    process.exit(0);
  }

  // a receiver for both ways of sending
  const got: { json: unknown[]; form: URLSearchParams[] } = { json: [], form: [] };
  const work = mkdtempSync(join(tmpdir(), "pr-explainer-smoke-"));
  cpSync(join(ROOT, "test", "fixtures", "workdir"), work, { recursive: true });
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST" && req.url === "/feedback") { got.json.push(JSON.parse(body)); res.writeHead(200, { "access-control-allow-origin": "*" }).end("{}"); return; }
      if (req.method === "OPTIONS") { res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type" }).end(); return; }
      if (req.method === "POST" && req.url === "/answer") { got.form.push(new URLSearchParams(body)); res.writeHead(303, { location: "/page" }).end(); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(join(work, "page", "index.html")));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;

  // ---- phone, light: reading the layers
  cli("render", work, "--submit", `json:${base}/feedback`);
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["clipboard-read", "clipboard-write"] });
  let page = await phone.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/page`);
  assert.equal(await page.locator("h1").textContent(), "Bulk discount <b>& friends</b>", "text from the brief is shown as text, never as HTML");
  assert.ok(await page.locator(".glance .g-does").isVisible(), "three sentences first");
  assert.equal(await page.locator("details.layer[open]").count(), 0, "deeper layers start closed");
  assert.equal(await page.locator("article.step:visible").count(), 1, "one step at a time");
  assert.ok(await page.locator("#step-st-qty").isVisible());
  await noSideScroll(page, "phone");
  await page.screenshot({ path: join(OUT, "phone-top.png") });
  ok("phone: three sentences, then step 1 of 3, deeper layers closed, no sideways scroll, brief text escaped");

  // steps: Looks good moves on; the strip and Prev move around; the place is kept
  await page.click('#step-st-qty .fb button[data-v="ok"]');
  await page.waitForSelector("#step-st-discount:visible");
  assert.match((await page.locator('#step-st-discount .snip summary a').first().getAttribute("href")) ?? "", /\/pull\/7\/commits\/bbb2222bbbb#diff-[0-9a-f]{64}R14-R16$/);
  assert.ok(await page.locator('.strip button[data-go="st-qty"].ok').count(), "the strip shows step 1 as good");
  await page.click('.strip button[data-go="st-cleanup"]');
  assert.ok(await page.locator("#step-st-cleanup").isVisible());
  await page.click('#step-st-cleanup .pager button[data-go="st-discount"]');
  assert.ok(await page.locator("#step-st-discount").isVisible());
  await page.screenshot({ path: join(OUT, "phone-step.png") });
  await page.reload();
  assert.ok(await page.locator("#step-st-discount").isVisible(), "the page reopens on the step you were reading");
  await page.click('#step-st-discount .fb button[data-v="change"]');
  await page.fill("#step-st-discount .fb textarea", "Use the constants");
  ok("steps: one at a time, Looks good moves on, strip and Prev/Next jump, code from the step's own commit, place kept on reload");

  await page.click("#summary > summary");
  const first = page.locator("#summary .snip").first();
  assert.match((await first.locator("summary a").getAttribute("href")) ?? "", /^https:\/\/github\.com\/example\/shop\/pull\/7\/files#diff-[0-9a-f]{64}R12$/);
  assert.match((await page.locator('.snip:has-text("(before)") summary a').getAttribute("href")) ?? "", /L12$/);
  assert.equal(await first.locator("tr.hit td.tx").textContent(), "    sum += i.price * i.qty;");
  assert.ok(await page.evaluate(() => [...document.querySelectorAll(".code")].every((c) => c.getBoundingClientRect().right <= innerWidth)), "code blocks stay inside the screen");
  ok("code under each item: cited lines marked, links to the PR's changed-files view (R new, L old), long lines scroll inside the block");

  await page.click("#pictures > summary");
  await page.waitForSelector("#viz-v-total .panel[data-panel=after] svg", { timeout: 15000 });
  await page.click('#viz-v-total [data-tab="before"]');
  await page.waitForSelector("#viz-v-total .panel[data-panel=before] svg", { timeout: 15000 });
  await page.click("#viz-v-total .zoom");
  assert.ok(await page.locator("#zoom[open] svg").count(), "full-size view shows the diagram");
  assert.match((await page.locator("#zoom-open").getAttribute("href")) ?? "", /^blob:/);
  await page.screenshot({ path: join(OUT, "phone-zoom.png") });
  await page.click("#zoom-close");
  ok("diagrams draw when their layer opens, before/after tabs work, full size opens");

  await openAll(page);
  await page.click('#risk-r-drift .fb button[data-v="change"]');
  await page.fill("#risk-r-drift .fb textarea", "Import the constants please");
  await page.click('#why-d-constants .fb button[data-v="question"]');
  await page.fill("#why-d-constants .fb textarea", "Who else uses them?");
  await page.reload();
  await openAll(page);
  assert.equal(await page.inputValue("#risk-r-drift .fb textarea"), "Import the constants please", "a draft survives a reload");
  assert.equal(await page.getAttribute('#step-st-qty .fb button[data-v="ok"]', "aria-pressed"), "true");
  await noSideScroll(page, "phone, all layers open");
  await page.screenshot({ path: join(OUT, "phone-full.png"), fullPage: true });
  ok("OK / Question / Change it on items, notes, and the draft kept across a reload");

  await page.click("#send");
  assert.match((await page.textContent("#status")) ?? "", /Choose a verdict/);
  await page.check('input[value="request-changes"]');
  await page.fill("#general", "Close, two fixes.");
  await page.click("#send");
  await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("Sent"));
  const sent = got.json[0] as { page: string; answers: Record<string, string>; comment: string };
  assert.equal(sent.page, "pr-shop-7");
  assert.equal(sent.answers.verdict, "request-changes");
  assert.equal(sent.answers["risk:r-drift"], "change");
  assert.match(sent.comment, /Verdict: Request changes\nFix from step 2 on; steps before it stand\.[\s\S]*Close, two fixes\.[\s\S]*Steps:\n- \[OK\] Step 1: Count quantity \(st-qty\)\n- \[Change it\] Step 2: Discount big orders \(st-discount\): Use the constants[\s\S]*Why:\n- \[Question\] Constants in their own file \(d-constants\): Who else uses them\?[\s\S]*Risks:\n- \[Change it\] Constants drift from the code \(r-drift\): Import the constants please/);
  ok("Send (JSON): a verdict is required, and the receiver gets the verdict, each mark and the text");

  await page.click("#copy");
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.equal(clip, sent.comment);
  ok("Copy as text gives the same text");
  await phone.close();

  // ---- since you last looked: a second version of the page, step 3's commit changed
  {
    const ctxL = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p1 = await ctxL.newPage();
    cli("render", work, "--submit", `json:${base}/feedback`, "--form-id", "since-v1");
    await p1.goto(`${base}/page`);
    await p1.click('.strip button[data-go="st-qty"]');
    await p1.click('#step-st-qty .fb button[data-v="ok"]');
    await p1.click('.strip button[data-go="st-cleanup"]');
    await p1.click('#step-st-cleanup .fb button[data-v="ok"]');
    const patch = join(work, "commits", "ccc3333cccc.patch");
    const original = readFileSync(patch, "utf8");
    writeFileSync(patch, original.replace("-gone", "-gone for good"));
    cli("render", work, "--submit", `json:${base}/feedback`, "--form-id", "since-v2");
    await p1.goto(`${base}/page`);
    assert.match((await p1.textContent("#since")) ?? "", /^Since you last looked: steps 1 and 2 did not change; your marks there are kept\. Step 3 changed\.$/);
    assert.equal(await p1.getAttribute('#step-st-qty .fb button[data-v="ok"]', "aria-pressed"), "true", "an unchanged step keeps its mark");
    assert.equal(await p1.getAttribute('#step-st-cleanup .fb button[data-v="ok"]', "aria-pressed"), "false", "a changed step asks again");
    assert.ok(await p1.locator("#step-st-cleanup").isVisible(), "the page opens on the changed step");
    assert.match((await p1.textContent("#step-st-cleanup .step-meta")) ?? "", /changed since you looked/);
    await p1.screenshot({ path: join(OUT, "phone-since.png") });
    writeFileSync(patch, original);
    await ctxL.close();
    ok("since you last looked: unchanged steps keep their marks, a changed step is tagged and opens first");
  }

  // ---- form mode (an inbox that takes a plain form post)
  cli("render", work, "--submit", `form:${base}/answer`, "--form-id", "review-shop-7");
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  page = await ctx2.newPage();
  await page.goto(`${base}/page`);
  await page.check('input[value="approve"]');
  await Promise.all([page.waitForURL(`${base}/page`), page.click("#send")]);
  const f = got.form[0]!;
  assert.equal(f.get("id"), "review-shop-7");
  assert.equal(f.get("answer"), "Approve");
  assert.match(f.get("note") ?? "", /^Review of example\/shop#7/);
  ok("Send (form): id, answer and note posted as a plain form");
  await ctx2.close();

  // ---- dark and desktop
  for (const [name, vp, scheme] of [["phone-dark", { width: 390, height: 844 }, "dark"], ["desktop", { width: 1200, height: 900 }, "light"], ["desktop-dark", { width: 1200, height: 900 }, "dark"]] as const) {
    const c = await browser.newContext({ viewport: vp, colorScheme: scheme });
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${base}/page`);
    await openAll(p);
    await p.waitForSelector("#viz-v-total svg", { timeout: 15000 });
    await noSideScroll(p, name);
    await p.screenshot({ path: join(OUT, `${name}.png`), fullPage: true });
    await c.close();
  }
  ok("dark and desktop: no sideways scroll, diagrams drawn");

  // ---- copy only, no receiver
  cli("render", work);
  const ctx3 = await browser.newContext();
  page = await ctx3.newPage();
  await page.goto(`${base}/page`);
  assert.equal(await page.locator("#send").count(), 0, "no Send button without a receiver");
  await ctx3.close();
  ok("without a receiver: Copy only");

  // ---- serve: no inbox at all; Send saves next to the page
  const { spawn } = await import("node:child_process");
  const servePort = String(port + 1);
  const srv = spawn(join(ROOT, "bin", "pr-explainer"), ["serve", work, "--port", servePort, "--no-open"], { env: { ...process.env, PR_EXPLAINER_CONFIG: "/nonexistent" }, stdio: "pipe" });
  try {
    await new Promise<void>((res, rej) => { srv.stdout.on("data", (d: Buffer) => { if (d.toString().includes("review page")) res(); }); srv.on("exit", () => rej(new Error("serve exited"))); });
    const ctx4 = await browser.newContext();
    page = await ctx4.newPage();
    await page.goto(`http://127.0.0.1:${servePort}/`);
    await page.check('input[value="questions"]');
    await page.fill("#general", "Saved locally");
    await page.click("#send");
    await page.waitForFunction(() => document.getElementById("status")?.textContent?.startsWith("Sent"));
    await ctx4.close();
    const shown = cli("answers", work);
    assert.match(shown, /Saved locally[\s\S]*\(verdict: questions\)/);
    ok("serve: the page on this computer, Send saves next to it, answers reads it back");
  } finally { srv.kill(); }

  assert.deepEqual(errors, [], "no script errors");
  server.close();
  console.log(`screenshots: ${OUT}`);
} finally {
  await browser.close();
}
