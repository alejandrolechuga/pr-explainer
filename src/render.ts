// Turns a checked brief into one self-contained review page: three sentences first, then the PR
// one step at a time, then deeper layers behind questions, and a way to send the review back.
import { createHash } from "node:crypto";
import type { Brief, CitationT } from "./brief.js";
import type { CheckResult, Checks } from "./checks.js";
import { commitForCitation, readingMinutes, type CommitDiff } from "./commits.js";
import type { PrContext } from "./context.js";
import { diffRows, excerpt, type DiffFile, type Row } from "./diff.js";
import { highlightLines } from "./highlight.js";

export interface RenderOptions {
  /** where "Send" goes: "json:<url>" posts JSON, "form:<url>" submits a plain form; none = copy only */
  submit?: string;
  /** id the feedback is filed under (lowercase letters, digits, dashes) */
  formId: string;
  /** longest note the receiver keeps; the page warns before sending more */
  noteLimit?: number;
  /** the raw diff, so each code citation can show the lines it points at */
  diffText?: string;
  /** each commit's own diff, so a step shows the code as that commit changed it */
  commitDiffs?: CommitDiff[];
  /** test results per commit, from `test-steps` */
  checks?: Checks | null;
  /** validator warnings, shown in the footer */
  warnings?: string[];
}

const MERMAID = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** GitHub's anchor for a file in a PR's "Files changed" view */
export function fileAnchor(path: string): string {
  return `diff-${createHash("sha256").update(path).digest("hex")}`;
}

const SOURCE_LABEL: Record<string, string> = {
  "intent-record": "Intent record",
  "pr-body": "PR description",
  commit: "Commit",
  issue: "Issue",
  doc: "Doc",
  "code-comment": "Comment in the code",
};

const RISK_ORDER = { high: 0, medium: 1, low: 2 } as const;

function riskMeta(risks: { severity: string }[]): string {
  if (!risks.length) return "none found";
  const n = (s: string) => risks.filter((r) => r.severity === s).length;
  return ["high", "medium", "low"].filter((s) => n(s)).map((s) => `${n(s)} ${s}`).join(", ");
}

export function formIdFor(ctx: PrContext, prefix = "pr-"): string {
  const name = ctx.repo.split("/").pop() ?? "repo";
  const tail = ctx.pr.number ? String(ctx.pr.number) : ctx.pr.head;
  return `${prefix}${name}-${tail}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

type CodeCite = Extract<CitationT, { kind: "code" }>;

/** where a snippet's lines come from, and where its GitHub link goes */
interface CodeSource {
  rows: Map<string, Row[]>;
  url: (path: string, side?: "new" | "old", line?: number, end?: number) => string | null;
  /** coloured lines per file and hunk, so a hunk is coloured once however often it is cited */
  colored: Map<string, string[]>;
}

/** one step of the page: a step from the brief, or a slice when the PR has no usable commits */
interface ViewStep {
  id: string;
  title: string;
  summary: string;
  why?: string;
  basis?: "stated" | "inferred";
  minutes: number;
  uses: string[];
  meta: string;
  /** what the step changed, ignoring line numbers: equal when a later version of the PR left it alone */
  fp: string;
  /** the tests at the step's last commit, when they were run */
  check?: CheckResult;
  body: string;
}

/** a short hash of the lines a step adds and removes, per file, so moved line numbers do not count as a change */
export function fingerprint(parts: [string, Row[]][]): string {
  const h = createHash("sha256");
  for (const [path, rows] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
    h.update(`${path}\n`);
    for (const r of rows) if (r.kind !== " ") h.update(`${r.kind}${r.text}\n`);
  }
  return h.digest("hex").slice(0, 16);
}

export function renderPage(brief: Brief, ctx: PrContext, files: DiffFile[], o: RenderOptions): string {
  const prUrl = ctx.pr.url;
  const anchorUrl = (base: string | null) => (path: string, side?: "new" | "old", line?: number, end?: number): string | null => {
    if (!base) return null;
    let a = `${base}#${fileAnchor(path)}`;
    if (line) {
      const s = side === "old" ? "L" : "R";
      a += `${s}${line}${end && end !== line ? `-${s}${end}` : ""}`;
    }
    return a;
  };
  const fileUrl = anchorUrl(prUrl ? `${prUrl}/files` : null);
  const prSource: CodeSource = { rows: o.diffText ? diffRows(o.diffText) : new Map(), url: fileUrl, colored: new Map() };

  const snippet = (c: CodeCite, src: CodeSource = prSource): string | null => {
    const ex = excerpt(src.rows.get(c.file), c.side, c.line, c.endLine ?? c.line);
    if (!ex.rows.length) return null;
    const lo = c.line, hi = c.endLine ?? c.line;
    const label = `${c.file}:${lo}${hi !== lo ? `–${hi}` : ""}${c.side === "old" ? " (before)" : ""}`;
    const href = src.url(c.file, c.side, lo, hi);
    // colour the whole hunk, so an excerpt that starts inside a comment or string is coloured right
    const hunk = ex.rows[0]!.hunk;
    const hunkRows = (src.rows.get(c.file) ?? []).filter((r) => r.hunk === hunk);
    const key = `${c.file}\0${hunk}`;
    const all = src.colored.get(key) ?? highlightLines(hunkRows.map((r) => r.text), c.file);
    src.colored.set(key, all);
    const from = hunkRows.indexOf(ex.rows[0]!);
    const colored = all.slice(from, from + ex.rows.length);
    const body = ex.rows.map((r, i) => {
      const n = c.side === "new" ? r.new : r.old;
      const hit = n !== undefined && n >= lo && n <= hi;
      const cls = r.kind === "+" ? "row-add" : r.kind === "-" ? "row-del" : "row-ctx";
      return `<tr class="${cls}${hit ? " hit" : ""}"><td class="ln">${r.kind === "-" ? r.old : r.new}</td><td class="mk">${r.kind === " " ? "" : r.kind === "-" ? "−" : "+"}</td><td class="tx">${colored[i] || " "}</td></tr>`;
    }).join("");
    return `<details class="snip" open><summary><span class="file">${esc(label)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">GitHub ↗</a>` : ""}</summary>
      <div class="code"><table>${body}</table></div>${ex.more ? `<p class="more">${ex.more} more line${ex.more === 1 ? "" : "s"}${href ? ` — <a href="${esc(href)}" target="_blank" rel="noopener">see all on GitHub</a>` : ""}</p>` : ""}</details>`;
  };

  const cite = (c: CitationT, src: CodeSource = prSource): string => {
    if (c.kind === "code") {
      const label = `${c.file}:${c.line}${c.endLine && c.endLine !== c.line ? `–${c.endLine}` : ""}${c.side === "old" ? " (before)" : ""}`;
      const href = src.url(c.file, c.side, c.line, c.endLine);
      return href ? `<a class="cite" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span class="cite">${esc(label)}</span>`;
    }
    const from = SOURCE_LABEL[c.source] ?? c.source;
    const ref = c.ref ? ` ${c.source === "commit" ? c.ref.slice(0, 7) : c.ref}` : "";
    return `<span class="quote"><q>${esc(c.quote)}</q> <span class="src">— ${esc(from + ref)}</span></span>`;
  };
  /** quotes, then code snippets; `srcFor` picks where each code citation's lines come from */
  const cites = (cs: CitationT[], srcFor: (c: CodeCite) => CodeSource = () => prSource): string => {
    const quotes = cs.filter((c) => c.kind === "source").map((c) => cite(c)).join("");
    const codeCs = cs.filter((c): c is CodeCite => c.kind === "code");
    const snips = codeCs.map((c) => snippet(c, srcFor(c)));
    const shown = snips.filter((x): x is string => !!x).join("");
    const chips = codeCs.filter((_, i) => !snips[i]).map((c) => cite(c, srcFor(c))).join("");
    return `${quotes ? `<div class="quotes">${quotes}</div>` : ""}${shown ? `<div class="snips">${shown}</div>` : ""}${chips ? `<div class="cites">${chips}</div>` : ""}`;
  };

  const basis = (b: "stated" | "inferred"): string =>
    b === "stated"
      ? `<span class="badge stated" title="The author wrote this down; the quote is checked against their words">Stated by the author</span>`
      : `<span class="badge guess" title="Not written down by the author; this is a reading of the code">Our reading — a guess</span>`;

  const riskPill = (r: "low" | "medium" | "high", word = "risk"): string => `<span class="pill ${r}">${r} ${word}</span>`;

  const fb = (kind: string, id: string, title: string, okLabel = "OK"): string =>
    `<div class="fb" data-item="${esc(`${kind}:${id}`)}" data-kind="${esc(kind)}" data-title="${esc(title)}">
      <div class="fb-buttons" role="group" aria-label="Your feedback on this">
        <button type="button" data-v="ok" aria-pressed="false">${esc(okLabel)}</button>
        <button type="button" data-v="question" aria-pressed="false">Question</button>
        <button type="button" data-v="change" aria-pressed="false">Change it</button>
      </div>
      <textarea hidden rows="2" aria-label="Your note"></textarea>
    </div>`;

  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const guesses = brief.decisions.filter((d) => d.basis === "inferred").length;
  const slices = [...brief.slices].sort((a, b) => a.readOrder - b.readOrder);
  const risks = [...brief.risks].sort((a, b) => RISK_ORDER[a.severity] - RISK_ORDER[b.severity]);
  const titleOf = new Map<string, string>([
    ...brief.risks.map((r) => [r.id, r.title] as [string, string]),
    ...brief.decisions.map((d) => [d.id, d.decision] as [string, string]),
  ]);
  const kindOf = new Map<string, string>([
    ...brief.risks.map((r) => [r.id, "risk"] as [string, string]),
    ...brief.decisions.map((d) => [d.id, "why"] as [string, string]),
  ]);

  const fileList = (paths: string[]): string => `<ul>${paths.map((p) => {
    const f = byPath.get(p);
    const href = fileUrl(p);
    const stat = f ? `<span class="stat"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span>` : "";
    return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(p)}</a>` : esc(p)} ${stat}</li>`;
  }).join("")}</ul>`;

  // ---- steps: the PR's commits in order, or its slices when there are no steps
  const commitDiffs = o.commitDiffs ?? [];
  const sources = new Map<string, CodeSource>();
  const commitSource = (sha: string): CodeSource => {
    const known = sources.get(sha);
    if (known) return known;
    const d = commitDiffs.find((x) => x.sha === sha);
    const src = { rows: d ? diffRows(d.text) : new Map<string, Row[]>(), url: anchorUrl(prUrl ? `${prUrl}/commits/${sha}` : null), colored: new Map<string, string[]>() };
    sources.set(sha, src);
    return src;
  };
  /** the result at the step's last commit that was tested */
  const checkOf = (shas: string[]): CheckResult | undefined =>
    [...shas].reverse().map((sha) => o.checks?.results.find((r) => r.sha === sha)).find(Boolean);
  const stepsFromCommits = (): ViewStep[] => brief.steps.map((s) => {
    const shas = s.commits.map((p) => ctx.commits.find((c) => c.sha.startsWith(p))?.sha ?? p);
    const mine = commitDiffs.filter((d) => shas.includes(d.sha));
    const changed = mine.reduce((n, d) => n + d.files.reduce((m, f) => m + f.added + f.removed, 0), 0);
    const srcFor = (c: CodeCite): CodeSource => commitSource(commitForCitation(mine, c)?.sha ?? shas[0]!);
    const commitLinks = shas.map((sha) => {
      const msg = ctx.commits.find((c) => c.sha === sha)?.message.split("\n")[0] ?? "";
      return prUrl ? `<a href="${esc(`${prUrl}/commits/${sha}`)}" target="_blank" rel="noopener" title="${esc(msg)}"><code>${sha.slice(0, 7)}</code></a>` : `<code title="${esc(msg)}">${sha.slice(0, 7)}</code>`;
    }).join(" ");
    return {
      id: s.id, title: s.title, summary: s.summary, ...(s.why ? { why: s.why } : {}), basis: s.basis,
      minutes: readingMinutes(changed), uses: s.uses,
      ...(checkOf(shas) ? { check: checkOf(shas)! } : {}),
      meta: `${shas.length === 1 ? "commit" : "commits"} ${commitLinks}`,
      fp: fingerprint(shas.flatMap((sha) => [...commitSource(sha).rows].map(([p, r]) => [p, r] as [string, Row[]]))),
      body: cites(s.evidence, srcFor),
    };
  });
  const stepsFromSlices = (): ViewStep[] => slices.map((s) => ({
    id: s.id, title: s.title, summary: s.summary, uses: [],
    minutes: readingMinutes(s.files.reduce((n, p) => n + (byPath.get(p)?.added ?? 0) + (byPath.get(p)?.removed ?? 0), 0)),
    meta: riskPill(s.risk),
    fp: fingerprint(s.files.map((p) => [p, prSource.rows.get(p) ?? []])),
    body: `<details class="files"><summary>${s.files.length} file${s.files.length === 1 ? "" : "s"}</summary>${fileList(s.files)}</details>`,
  }));
  const fromCommits = brief.steps.length > 0;
  const steps = fromCommits ? stepsFromCommits() : stepsFromSlices();
  const stepNo = new Map(steps.map((s, i) => [s.id, i + 1] as const));
  const totalMinutes = steps.reduce((n, s) => n + s.minutes, 0);

  const tested = steps.filter((s) => s.check);
  const failing = steps.map((s, i) => [s, i + 1] as const).filter(([s]) => s.check && !s.check.ok);
  const testSummary = !tested.length ? "" : failing.length ? ` · tests fail at step ${failing.map(([, n]) => n).join(", ")}` : tested.length === steps.length ? " · tests pass at every step" : ` · tests pass at the ${tested.length} steps tested`;
  const stepLink = (id: string) => `<a href="#step-${esc(id)}" data-go="${esc(id)}">step ${stepNo.get(id)}</a>`;
  const stepCard = (s: ViewStep, i: number): string => {
    const usedBy = steps.filter((x) => x.uses.includes(s.id)).map((x) => x.id);
    const links = [
      s.uses.length ? `Builds on ${s.uses.map(stepLink).join(", ")}.` : "",
      usedBy.length ? `Later, ${usedBy.map(stepLink).join(", ")} ${usedBy.length === 1 ? "relies" : "rely"} on this.` : "",
    ].filter(Boolean).join(" ");
    const prev = steps[i - 1], next = steps[i + 1];
    return `<article class="step" id="step-${esc(s.id)}" data-step="${esc(s.id)}" data-fp="${s.fp}"${i ? " hidden" : ""}>
      <p class="step-meta"><b>Step ${i + 1} of ${steps.length}</b> · about ${s.minutes} min · ${s.meta}${s.check ? ` ${s.check.ok ? `<span class="pill low">tests pass</span>` : `<span class="pill high">tests fail</span>`}` : ""}</p>
      <h3 class="step-title">${esc(s.title)}</h3>
      <p class="step-summary">${esc(s.summary)}</p>
      ${s.why ? `<p class="step-why"><b>Why:</b> ${esc(s.why)} ${s.basis ? basis(s.basis) : ""}</p>` : ""}
      ${links ? `<p class="step-links">${links}</p>` : ""}
      ${s.check && !s.check.ok ? `<details class="test-out"><summary>Why the tests fail here (last lines of the output)</summary><pre>${esc(s.check.tail)}</pre></details>` : ""}
      ${s.body}
      ${fb("step", s.id, `Step ${i + 1}: ${s.title}`, "Looks good")}
      <div class="pager">
        ${prev ? `<button type="button" data-go="${esc(prev.id)}">← Step ${i}</button>` : "<span></span>"}
        ${next ? `<button type="button" class="next" data-go="${esc(next.id)}">Step ${i + 2} →</button>` : `<a class="next" href="#review">Your verdict ↓</a>`}
      </div>
    </article>`;
  };
  const strip = `<ol class="strip" aria-label="Steps in order">${steps.map((s, i) =>
    `<li><button type="button" data-go="${esc(s.id)}" aria-current="${i ? "false" : "step"}" title="${esc(s.title)}"${s.check ? ` class="${s.check.ok ? "test-pass" : "test-fail"}"` : ""}><span class="dot">${i + 1}</span><span class="st">${esc(s.title)}</span></button></li>`).join("")}</ol>`;
  const stepsSection = `<section class="steps" id="steps">
    <h2>${fromCommits ? "Step by step" : "Part by part"} <span class="meta">${steps.length} ${fromCommits ? "steps" : "parts"} · about ${totalMinutes} min${testSummary}</span></h2>
    ${fromCommits ? "" : `<p class="muted">This PR's commits do not read as steps, so it is cut into parts instead.</p>`}
    <p class="since" id="since" hidden></p>
    ${strip}
    ${steps.map(stepCard).join("")}
  </section>`;

  // ---- the first screen: three sentences and where to look
  const g = brief.glance;
  const lookHere = [
    ...(failing.length ? [`<li><span class="pill high">tests fail</span> <a href="#step-${esc(failing[0]![0].id)}" data-go="${esc(failing[0]![0].id)}">first at step ${failing[0]![1]}: ${esc(failing[0]![0].title)}</a></li>`] : []),
    ...risks.filter((r) => r.severity !== "low").slice(0, 3).map((r) => `<li>${riskPill(r.severity)} <a href="#risk-${esc(r.id)}">${esc(r.title)}</a></li>`),
    ...(brief.mismatches.length ? [`<li><span class="pill medium">mismatch</span> <a href="#plan">${brief.mismatches.length} place${brief.mismatches.length === 1 ? "" : "s"} where the code differs from what was said</a></li>`] : []),
  ];
  const glance = `<section class="glance" id="glance">
    <p class="g-does">${esc(g?.does ?? brief.intent.summary)}</p>
    ${g ? `<p><span class="lbl">For the user</span> ${esc(g.forUser)}</p><p><span class="lbl">Check</span> ${esc(g.lookAt)}</p>` : ""}
    ${lookHere.length ? `<ul class="lookhere">${lookHere.join("")}</ul>` : ""}
    ${ctx.intentRecord ? "" : `<p class="callout">No intent record: reasons marked <b>a guess</b> are a reading of the code, not the author's words.</p>`}
  </section>`;

  // ---- "tell me more": every deeper layer, closed, titled as the question it answers
  const layer = (id: string, title: string, meta: string, body: string): string =>
    `<details class="layer" id="${id}">
      <summary><span class="t">${esc(title)}</span><span class="meta">${esc(meta)}</span></summary>
      <div class="layer-body">${body}</div>
    </details>`;

  const summaryBody = `
    <div class="intent">${basis(brief.intent.basis)}<p>${esc(brief.intent.summary)}</p>${cites(brief.intent.evidence)}</div>
    <h3>What changes</h3>
    <div class="ba-list">${brief.beforeAfter.map((b) => `
      <article class="ba">
        <h4>${esc(b.area)}</h4>
        <div class="ba-grid">
          <div class="before"><span class="lbl">Before</span><p>${esc(b.before)}</p></div>
          <div class="after"><span class="lbl">After</span><p>${esc(b.after)}</p></div>
        </div>
        ${cites(b.evidence)}
      </article>`).join("")}
    </div>`;

  const mapBody = `<ol class="slices">${slices.map((s) => `<li class="slice" id="slice-${esc(s.id)}">
      <div class="row"><h4>${esc(s.title)}</h4>${riskPill(s.risk)}</div>
      <p>${esc(s.summary)}</p>
      <details class="files"><summary>${s.files.length} file${s.files.length === 1 ? "" : "s"}</summary>${fileList(s.files)}</details>
    </li>`).join("")}</ol>`;

  const whyBody = brief.decisions.length
    ? brief.decisions.map((d) => `
      <article class="item" id="why-${esc(d.id)}">
        <div class="row"><h4>${esc(d.decision)}</h4>${basis(d.basis)}</div>
        <p><b>Why:</b> ${esc(d.why)}</p>
        ${d.alternatives.length ? `<p class="alts"><b>Not chosen:</b> ${d.alternatives.map(esc).join(" · ")}</p>` : ""}
        ${cites(d.evidence)}
        ${fb("why", d.id, d.decision)}
      </article>`).join("")
    : `<p class="empty">No decisions worth calling out.</p>`;

  const picsBody = brief.visuals.length
    ? brief.visuals.map((v) => {
      const panel = (which: string, src: string, show: boolean): string =>
        `<div class="panel" data-panel="${which}"${show ? "" : " hidden"}><pre class="mermaid">${esc(src)}</pre></div>`;
      const tabs = v.before
        ? `<div class="tabs" role="tablist"><button type="button" role="tab" data-tab="before" aria-selected="false">Before</button><button type="button" role="tab" data-tab="after" aria-selected="true">After</button></div>`
        : "";
      return `<figure class="viz" id="viz-${esc(v.id)}">
        <div class="row"><h4>${esc(v.title)}</h4>${tabs}</div>
        <div class="canvas">${v.before ? panel("before", v.before, false) : ""}${panel("after", v.after, true)}</div>
        <figcaption>${esc(v.caption)} <button type="button" class="zoom">Full size</button></figcaption>
        ${fb("picture", v.id, v.title)}
      </figure>`;
    }).join("")
    : `<p class="empty">No diagrams: no structure changed enough to need one.</p>`;

  const planBody = brief.mismatches.length
    ? brief.mismatches.map((m, i) => `
      <article class="item mismatch">
        <div class="ba-grid">
          <div class="before"><span class="lbl">The plan says</span><p>${esc(m.claim)}</p></div>
          <div class="after"><span class="lbl">The code does</span><p>${esc(m.observed)}</p></div>
        </div>
        ${cites(m.evidence)}
        ${fb("plan", `m${i + 1}`, m.claim)}
      </article>`).join("")
    : `<p class="empty">No differences found between what the PR says it does and what the code does.</p>`;

  const risksBody = risks.length
    ? risks.map((r) => `
      <article class="item risk ${r.severity}" id="risk-${esc(r.id)}">
        <div class="row"><h4>${esc(r.title)}</h4>${riskPill(r.severity)}</div>
        <p>${esc(r.scenario)}</p>
        ${cites(r.evidence)}
        ${fb("risk", r.id, r.title)}
      </article>`).join("")
    : `<p class="empty">Nothing found that is likely to go wrong.</p>`;

  const optionsBody = brief.options.length
    ? brief.options.map((op) => `
      <article class="item" id="option-${esc(op.id)}">
        <h4>${esc(op.change)}</h4>
        <p><b>Tradeoff:</b> ${esc(op.tradeoff)}</p>
        ${op.relatesTo.length ? `<p class="rel">Answers: ${op.relatesTo.map((id) => `<a href="#${kindOf.get(id) === "risk" ? "risk" : "why"}-${esc(id)}">${esc(titleOf.get(id) ?? id)}</a>`).join(" · ")}</p>` : ""}
        ${fb("option", op.id, op.change)}
      </article>`).join("")
    : `<p class="empty">No changes suggested.</p>`;

  const sendNote = o.submit
    ? `<button type="button" id="send" class="primary">Send review</button>`
    : "";
  const reviewBody = `
    <fieldset class="verdict">
      <legend>Your verdict</legend>
      ${[["approve", "Approve"], ["approve-with-changes", "Approve, with the changes I marked"], ["request-changes", "Request changes"], ["questions", "I have questions first"]]
        .map(([v, l]) => `<label><input type="radio" name="verdict" value="${v}"> ${l}</label>`).join("")}
    </fieldset>
    <label class="note-label" for="general">Anything else</label>
    <textarea id="general" rows="4"></textarea>
    <p id="tally" class="muted"></p>
    <div class="actions">${sendNote}<button type="button" id="copy">Copy as text</button></div>
    <p id="status" role="status" aria-live="polite"></p>`;

  const highRisks = brief.risks.filter((r) => r.severity === "high").length;
  const config = {
    formId: o.formId,
    submit: o.submit ?? null,
    noteLimit: o.noteLimit ?? null,
    pr: `${ctx.repo}${ctx.pr.number ? `#${ctx.pr.number}` : ` (${ctx.pr.head})`}`,
    title: brief.pr.title,
    stepWord: fromCommits ? "step" : "part",
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<link rel="icon" href="data:,">
<title>${esc(`${ctx.repo.split("/").pop()}${ctx.pr.number ? ` #${ctx.pr.number}` : ""} explained`)}</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <p class="repo">${esc(ctx.repo)}${ctx.pr.number ? ` · #${ctx.pr.number}` : ""} · <code>${esc(ctx.pr.head)}</code> → <code>${esc(ctx.pr.base)}</code></p>
  <h1>${esc(brief.pr.title)}</h1>
  <p class="stats"><span>${files.length} files</span> <span class="add">+${added}</span> <span class="del">−${removed}</span>${highRisks ? ` <span class="pill high">${highRisks} high risk</span>` : ""}${prUrl ? ` <a href="${esc(prUrl)}" target="_blank" rel="noopener">Open on GitHub</a>` : ""}</p>
</header>
<main>
${glance}
${stepsSection}
<section class="more" id="more">
<h2>Tell me more</h2>
${layer("summary", "What is it for, and what changes?", `${brief.beforeAfter.length} change${brief.beforeAfter.length === 1 ? "" : "s"}`, summaryBody)}
${layer("why", "Why was it built this way?", `${brief.decisions.length} decision${brief.decisions.length === 1 ? "" : "s"}${guesses ? `, ${guesses} guessed` : ""}`, whyBody)}
${layer("pictures", "Show me a picture", `${brief.visuals.length} diagram${brief.visuals.length === 1 ? "" : "s"}`, picsBody)}
${layer("plan", "Does the code match what was said?", brief.mismatches.length ? `${brief.mismatches.length} difference${brief.mismatches.length === 1 ? "" : "s"}` : "yes", planBody)}
${layer("risks", "What could go wrong?", riskMeta(risks), risksBody)}
${layer("options", "What could we change?", `${brief.options.length} option${brief.options.length === 1 ? "" : "s"}`, optionsBody)}
${layer("map", "Which files go together?", `${slices.length} group${slices.length === 1 ? "" : "s"}`, mapBody)}
</section>
<section class="review" id="review"><h2>Your review</h2>${reviewBody}</section>
</main>
<footer>Every file:line and quote on this page was checked against the PR${o.warnings?.length ? ` (${o.warnings.length} note${o.warnings.length === 1 ? "" : "s"}: ${o.warnings.map(esc).join("; ")})` : ""}. Made with pr-explainer.</footer>
<dialog id="zoom"><div class="zoom-bar"><a id="zoom-open" target="_blank" rel="noopener">Open in new tab</a><button type="button" id="zoom-close">Close</button></div><div id="zoom-body"></div></dialog>
<script type="application/json" id="cfg">${JSON.stringify(config).replace(/</g, "\\u003c")}</script>
<script src="${MERMAID}"></script>
<script>${JS}</script>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f7f6f2;--surface:#fff;--ink:#1d1e22;--muted:#5f5e58;--line:#e2dfd7;--accent:#2f5bd3;--accent-ink:#fff;
--high:#b42318;--high-bg:#fdecea;--medium:#9a4a06;--medium-bg:#fff2e0;--low:#3d5f12;--low-bg:#eef6e2;
--stated:#1f6b4f;--stated-bg:#e3f4ec;--guess:#7a5b00;--guess-bg:#fff6d6;--add:#1f7a3a;--del:#b42318;--code:#f0eee8;--code-bg:#fbfaf7;--add-bg:#e6f4ea;--del-bg:#fdecea;--hl-kw:#cf222e;--hl-str:#0a3069;--hl-com:#6e7781;--hl-num:#0550ae;--hl-fn:#8250df;--hl-type:#953800;--hl-tag:#116329;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#14151a;--surface:#1c1e24;--ink:#e9e7e2;--muted:#a3a19a;--line:#2e3139;--accent:#8ea6ff;--accent-ink:#0d0f14;
--high:#ff8f84;--high-bg:#3a1d1b;--medium:#ffb870;--medium-bg:#3a2a16;--low:#a8d277;--low-bg:#1f2e14;
--stated:#7fd7b0;--stated-bg:#14322a;--guess:#f0cf6a;--guess-bg:#3a3214;--add:#7fd38f;--del:#ff8f84;--code:#262931;--code-bg:#17191e;--add-bg:#173022;--del-bg:#3a1d1b;--hl-kw:#ff7b72;--hl-str:#a5d6ff;--hl-com:#8b949e;--hl-num:#79c0ff;--hl-fn:#d2a8ff;--hl-type:#ffa657;--hl-tag:#7ee787;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#14151a;--surface:#1c1e24;--ink:#e9e7e2;--muted:#a3a19a;--line:#2e3139;--accent:#8ea6ff;--accent-ink:#0d0f14;
--high:#ff8f84;--high-bg:#3a1d1b;--medium:#ffb870;--medium-bg:#3a2a16;--low:#a8d277;--low-bg:#1f2e14;
--stated:#7fd7b0;--stated-bg:#14322a;--guess:#f0cf6a;--guess-bg:#3a3214;--add:#7fd38f;--del:#ff8f84;--code:#262931;--code-bg:#17191e;--add-bg:#173022;--del-bg:#3a1d1b;--hl-kw:#ff7b72;--hl-str:#a5d6ff;--hl-com:#8b949e;--hl-num:#79c0ff;--hl-fn:#d2a8ff;--hl-type:#ffa657;--hl-tag:#7ee787;color-scheme:dark}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;overflow-wrap:anywhere}
a{color:var(--accent)}
code{font:0.88em ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
.top{padding:14px 16px 2px}
.top>*{max-width:780px;margin-left:auto;margin-right:auto}
.repo{margin:0;color:var(--muted);font-size:13px}
h1{font-size:20px;line-height:1.3;margin:4px auto 6px}
.stats{margin:0 auto 8px;font-size:14px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;color:var(--muted)}
.add{color:var(--add);font-variant-numeric:tabular-nums}.del{color:var(--del);font-variant-numeric:tabular-nums}
main{max-width:780px;margin:0 auto;padding:16px}
.glance,.steps,.review{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin:0 0 14px;padding:14px 16px}
.g-does{font-size:18px;line-height:1.45;margin:0 0 8px;font-weight:550}
.glance .lbl{display:block;margin-top:8px}.glance p{margin:2px 0}
.lookhere{list-style:none;padding:0;margin:10px 0 0;display:grid;gap:6px;font-size:15px}
.steps h2,.more h2,.review h2{font-size:17px;margin:0 0 10px;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline}
h2 .meta{color:var(--muted);font-size:13px;font-weight:400}
.strip{list-style:none;padding:8px 0 6px;margin:0 0 12px;display:flex;overflow-x:auto;scrollbar-width:thin}
.strip li{flex:1 0 64px;max-width:140px;position:relative}
.strip li+li::before{content:"";position:absolute;top:23px;right:50%;width:100%;height:2px;background:var(--line);z-index:0}
.strip button{position:relative;z-index:1;width:100%;border:0;background:none;color:var(--muted);padding:0 2px;cursor:pointer;display:flex;flex-direction:column;align-items:center;gap:3px;font-size:12px;line-height:1.25}
.strip .dot{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:var(--surface);border:2px solid var(--line);color:var(--ink);font-weight:650;font-size:13px}
.strip .st{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;text-align:center}
.strip button[aria-current="step"]{color:var(--ink)}
.strip button[aria-current="step"] .dot{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 25%,transparent)}
.strip button.ok .dot{background:var(--stated-bg);border-color:var(--stated);color:var(--stated)}
.strip button.question .dot{background:var(--guess-bg);border-color:var(--guess);color:var(--guess)}
.strip button.change .dot{background:var(--high-bg);border-color:var(--high);color:var(--high)}
.strip button.test-pass .dot::before,.strip button.test-fail .dot::before{position:absolute;bottom:-6px;right:-7px;width:15px;height:15px;border-radius:50%;font-size:10px;line-height:15px;text-align:center;border:2px solid var(--surface);font-weight:700}
.strip button.test-pass .dot::before{content:"✓";background:var(--stated);color:var(--surface)}
.strip button.test-fail .dot::before{content:"✕";background:var(--high);color:var(--surface)}
.strip .dot{position:relative}
.test-out{margin:8px 0;border:1px solid var(--high);border-radius:8px;background:var(--high-bg)}
.test-out summary{cursor:pointer;padding:6px 10px;font-size:14px;color:var(--high);font-weight:600}
.test-out pre{margin:0;padding:8px 10px;font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;background:var(--code-bg);color:var(--ink);border-radius:0 0 8px 8px}
.since{background:var(--stated-bg);border-left:3px solid var(--stated);padding:8px 12px;border-radius:6px;font-size:14px;margin:0 0 12px}
.strip button.since-changed .dot::after,.strip button.since-new .dot::after{content:"";position:absolute;top:-7px;right:-9px;width:11px;height:11px;border-radius:50%;background:var(--medium);border:2px solid var(--surface)}
.tag{display:inline-block;font-size:12px;font-weight:600;padding:1px 7px;border-radius:999px;background:var(--medium-bg);color:var(--medium)}
.step{border-top:1px solid var(--line);padding-top:12px;scroll-margin-top:12px}
.step-meta{font-size:13px;color:var(--muted);margin:0}
.step-title{font-size:18px;margin:4px 0 2px;text-transform:none;letter-spacing:0;color:var(--ink)}
.step-summary{font-size:16px}
.step-why,.step-links{font-size:15px}
.step-links{color:var(--muted)}
.pager{display:flex;justify-content:space-between;gap:8px;margin-top:12px}
.pager button,.pager a{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:8px 14px;min-height:44px;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center}
.pager .next{background:var(--accent);color:var(--accent-ink);border-color:var(--accent);font-weight:600}
.more{margin:22px 0 0}
.layer{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin:0 0 10px;scroll-margin-top:12px}
.layer>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:14px 16px}
.layer>summary::-webkit-details-marker{display:none}
.layer>summary .t{font-weight:600;font-size:16px}
.layer>summary .meta{color:var(--muted);font-size:13px;margin-left:auto}
.layer:not([open])>summary .meta::after{content:" ▸"}
.layer-body{padding:0 16px 16px}
h3{font-size:14px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:18px 0 8px}
h4{font-size:16px;margin:0;line-height:1.35}
p{margin:6px 0}
.row{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;justify-content:space-between}
.callout{background:var(--guess-bg);color:var(--ink);border-left:3px solid var(--guess);padding:8px 12px;border-radius:6px;font-size:14px}
.intent p{font-size:17px;margin:8px 0}
.badge{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap}
.badge.stated{background:var(--stated-bg);color:var(--stated)}
.badge.guess{background:var(--guess-bg);color:var(--guess);border:1px dashed currentColor}
.pill{display:inline-block;font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;white-space:nowrap;text-transform:capitalize}
.pill.high{background:var(--high-bg);color:var(--high)}.pill.medium{background:var(--medium-bg);color:var(--medium)}.pill.low{background:var(--low-bg);color:var(--low)}
.ba-list{display:grid;gap:10px}
.ba,.item,.slice{border:1px solid var(--line);border-radius:10px;padding:12px}
.ba-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px}
@media (max-width:560px){.ba-grid{grid-template-columns:1fr}}
.ba-grid>div{background:var(--bg);border-radius:8px;padding:8px 10px}
.ba-grid .after{box-shadow:inset 3px 0 0 var(--accent)}
.lbl{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}
.ba-grid p{margin:2px 0 0;font-size:15px}
.slices{list-style:none;counter-reset:s;padding:0;margin:0;display:grid;gap:10px}
.slice{counter-increment:s;position:relative;padding-left:44px}
.slice::before{content:counter(s);position:absolute;left:12px;top:12px;width:22px;height:22px;border-radius:6px;border:1px solid var(--line);display:grid;place-items:center;font-size:12px;color:var(--muted)}
.files summary{cursor:pointer;color:var(--muted);font-size:14px}
.files ul{margin:6px 0 0;padding-left:18px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.stat{font-size:12px}
.item{margin:0 0 10px}
.risk{border-left-width:4px}.risk.high{border-left-color:var(--high)}.risk.medium{border-left-color:var(--medium)}.risk.low{border-left-color:var(--low)}
.alts,.rel{font-size:14px;color:var(--muted)}
.quotes{margin:8px 0 0;display:grid;gap:4px}
.quote{display:block;font-size:14px;border-left:3px solid var(--stated);padding:2px 0 2px 10px}
.quote q{font-style:italic}.quote .src{color:var(--muted);font-size:13px;white-space:nowrap}
.cites{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.cite{font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);color:var(--ink);text-decoration:none;padding:3px 7px;border-radius:5px}
a.cite:hover{outline:1px solid var(--accent)}
.empty{color:var(--muted);font-style:italic}
.snips{display:grid;gap:8px;margin-top:10px}
.snip{border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--code-bg)}
.snip>summary{cursor:pointer;display:flex;justify-content:space-between;gap:8px;align-items:center;padding:6px 10px;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--code);color:var(--ink)}
.snip>summary .file{overflow-wrap:anywhere}
.snip>summary a{flex:none;font-family:system-ui,sans-serif;font-size:12px;text-decoration:none}
.code{overflow-x:auto;-webkit-overflow-scrolling:touch}
.code table{border-collapse:collapse;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;min-width:100%;tab-size:2}
.code td{padding:0 6px;white-space:pre;vertical-align:top}
.code td.ln{color:var(--muted);text-align:right;user-select:none;min-width:2.6em;padding:0 4px;opacity:.75}
.code td.mk{user-select:none;width:1em;padding:0 2px;text-align:center}
.code td.tx{width:100%;padding-right:12px}
.code tr.row-add{background:var(--add-bg)}.code tr.row-add td.mk{color:var(--add)}
.code tr.row-del{background:var(--del-bg)}.code tr.row-del td.mk{color:var(--del)}
.code tr.hit td.ln{opacity:1;color:var(--ink);font-weight:600}
@media (max-width:560px){.code td.tx{white-space:pre-wrap;overflow-wrap:anywhere}}
.code .hljs-keyword,.code .hljs-meta .hljs-keyword,.code .hljs-doctag,.code .hljs-template-tag,.code .hljs-variable.language_{color:var(--hl-kw)}
.code .hljs-string,.code .hljs-meta .hljs-string,.code .hljs-template-variable{color:var(--hl-str)}
.code .hljs-comment,.code .hljs-quote,.code .hljs-meta{color:var(--hl-com)}.code .hljs-comment{font-style:italic}
.code .hljs-number,.code .hljs-literal,.code .hljs-attr,.code .hljs-attribute,.code .hljs-property,.code .hljs-selector-attr,.code .hljs-selector-class,.code .hljs-selector-id,.code .hljs-symbol,.code .hljs-bullet,.code .hljs-section{color:var(--hl-num)}
.code .hljs-title,.code .hljs-title.function_,.code .hljs-title.class_{color:var(--hl-fn)}
.code .hljs-type,.code .hljs-built_in,.code .hljs-variable,.code .hljs-params .hljs-type{color:var(--hl-type)}
.code .hljs-regexp,.code .hljs-tag,.code .hljs-name,.code .hljs-selector-tag,.code .hljs-addition{color:var(--hl-tag)}
.code .hljs-emphasis{font-style:italic}.code .hljs-strong{font-weight:600}
.more{font-size:12px;color:var(--muted);margin:0;padding:4px 10px;border-top:1px solid var(--line)}
.viz{margin:0 0 12px;border:1px solid var(--line);border-radius:10px;padding:12px}
.tabs{display:inline-flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.tabs button{border:0;background:transparent;color:var(--ink);font:inherit;font-size:13px;padding:5px 12px;cursor:pointer;min-height:32px}
.tabs button[aria-selected="true"]{background:var(--ink);color:var(--bg)}
.canvas{margin-top:10px;overflow-x:auto;background:var(--bg);border-radius:8px;padding:8px}
.canvas pre.mermaid{margin:0;font:12px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;color:var(--muted)}
.canvas pre.mermaid[data-processed]{color:inherit;white-space:normal;text-align:center}
.canvas svg{max-width:100%;height:auto}
.canvas.wide{position:relative}
.canvas.wide::after{content:"Scroll sideways, or open Full size";position:sticky;left:0;display:block;font-size:12px;color:var(--muted);padding-top:4px}
figcaption{font-size:14px;color:var(--muted);margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
button{font:inherit}
.zoom,#copy,#zoom-close,.fb-buttons button{border:1px solid var(--line);background:var(--surface);color:var(--ink);border-radius:8px;padding:6px 12px;cursor:pointer;min-height:36px}
.fb{margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}
.fb-buttons{display:flex;gap:6px;flex-wrap:wrap}
.fb-buttons button{font-size:14px;min-width:72px}
.fb-buttons button[aria-pressed="true"][data-v="ok"]{background:var(--stated-bg);color:var(--stated);border-color:var(--stated)}
.fb-buttons button[aria-pressed="true"][data-v="question"]{background:var(--guess-bg);color:var(--guess);border-color:var(--guess)}
.fb-buttons button[aria-pressed="true"][data-v="change"]{background:var(--high-bg);color:var(--high);border-color:var(--high)}
textarea{width:100%;margin-top:8px;font:inherit;font-size:15px;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
textarea:focus,button:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.verdict{border:0;padding:0;margin:0 0 10px;display:grid;gap:6px}
.verdict legend{font-weight:600;margin-bottom:6px}
.verdict label{display:flex;gap:10px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:10px 12px;cursor:pointer}
.verdict label:has(input:checked){border-color:var(--accent);box-shadow:inset 0 0 0 1px var(--accent)}
.note-label{font-weight:600}
.muted{color:var(--muted);font-size:14px}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.primary{border:0;background:var(--accent);color:var(--accent-ink);border-radius:8px;padding:10px 18px;font-weight:600;cursor:pointer;min-height:44px}
#copy{min-height:44px}
#status{font-size:14px;min-height:1.4em}
#status.ok{color:var(--stated)}#status.err{color:var(--high)}
footer{max-width:780px;margin:0 auto;padding:4px 16px 40px;color:var(--muted);font-size:13px}
dialog#zoom{width:100vw;height:100dvh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--bg);color:var(--ink)}
.zoom-bar{position:sticky;top:0;left:0;display:flex;justify-content:space-between;gap:8px;padding:10px 16px;background:var(--surface);border-bottom:1px solid var(--line)}
#zoom-body{overflow:auto;height:calc(100dvh - 58px);padding:16px}
#zoom-body svg{max-width:none!important;width:auto;height:auto;min-width:min(100%,900px)}
`;

const JS = `
(() => {
  const cfg = JSON.parse(document.getElementById('cfg').textContent);
  const KEY = 'pr-explainer:' + cfg.formId;
  const store = { get() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } },
    set(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch {} } };
  const state = Object.assign({ items: {}, verdict: '', general: '', at: '' }, store.get());
  function save() { store.set(state); tally(); remember(); }

  // one step at a time
  const steps = [...document.querySelectorAll('.step')];
  const stepIndex = (itemId) => steps.findIndex((s) => 'step:' + s.dataset.step === itemId);
  function showStep(id, scroll) {
    const el = steps.find((s) => s.dataset.step === id); if (!el) return;
    for (const s of steps) s.hidden = s !== el;
    for (const b of document.querySelectorAll('.strip button')) b.setAttribute('aria-current', b.dataset.go === id ? 'step' : 'false');
    const cur = document.querySelector('.strip button[aria-current="step"]'); if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'center' });
    state.at = id; store.set(state);
    if (scroll) document.getElementById('steps').scrollIntoView({ block: 'start' });
  }
  function nextStep(el) {
    const i = steps.indexOf(el);
    setTimeout(() => { if (steps[i + 1]) showStep(steps[i + 1].dataset.step, true); else document.getElementById('review').scrollIntoView({ block: 'start' }); }, 250);
  }
  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-go]'); if (!g) return;
    e.preventDefault(); showStep(g.dataset.go, !g.closest('.strip'));
  });
  let fromHash = '';
  try { fromHash = location.hash.startsWith('#step-') ? decodeURIComponent(location.hash.slice(6)) : ''; } catch {}

  // since you last looked: a step whose code is unchanged keeps the mark it had on an earlier
  // version of this PR's page (same browser); changed and new steps ask again
  const PKEY = 'pr-explainer:pr:' + cfg.pr;
  let before = null;
  try { before = JSON.parse(localStorage.getItem(PKEY) || 'null'); } catch {}
  function remember() {
    const byFp = {}, byId = {};
    for (const s of steps) {
      byId[s.dataset.step] = s.dataset.fp;
      const it = state.items['step:' + s.dataset.step];
      if (it) byFp[s.dataset.fp] = { v: it.v, note: it.note };
    }
    try { localStorage.setItem(PKEY, JSON.stringify({ page: cfg.formId, byFp, byId })); } catch {}
  }
  const since = {};
  if (before && before.page !== cfg.formId && steps.length) {
    const oldFps = new Set(Object.values(before.byId || {}));
    steps.forEach((s) => {
      const id = s.dataset.step, fp = s.dataset.fp, mark = (before.byFp || {})[fp];
      if (oldFps.has(fp)) {
        since[id] = 'same';
        if (mark && !state.items['step:' + id]) state.items['step:' + id] = { v: mark.v, note: mark.note || '', kind: 'step', title: s.querySelector('.fb').dataset.title };
      } else since[id] = id in (before.byId || {}) ? 'changed' : 'new';
      if (since[id] !== 'same') {
        const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = since[id] === 'new' ? 'new since you looked' : 'changed since you looked';
        s.querySelector('.step-meta').append(' ', tag);
        const b = document.querySelector('.strip button[data-go="' + CSS.escape(id) + '"]'); if (b) b.classList.add('since-' + since[id]);
      }
    });
    const nums = (k) => steps.map((s, i) => since[s.dataset.step] === k ? i + 1 : 0).filter(Boolean);
    const list = (ns) => ns.length === 1 ? cfg.stepWord + ' ' + ns[0] : cfg.stepWord + 's ' + ns.slice(0, -1).join(', ') + ' and ' + ns.at(-1);
    const same = nums('same'), changed = nums('changed'), fresh = nums('new');
    const parts = [];
    if (same.length) parts.push((same.length === steps.length ? 'Nothing changed' : list(same) + ' did not change') + '; your marks there are kept.');
    if (changed.length) parts.push(list(changed).replace(/^./, (c) => c.toUpperCase()) + ' changed.');
    if (fresh.length) parts.push(list(fresh).replace(/^./, (c) => c.toUpperCase()) + (fresh.length === 1 ? ' is new.' : ' are new.'));
    const box = document.getElementById('since');
    box.textContent = 'Since you last looked: ' + parts.join(' ');
    box.hidden = false;
    store.set(state);
  }
  remember();
  const firstOpen = steps.find((s) => since[s.dataset.step] && since[s.dataset.step] !== 'same') || steps.find((s) => !state.items['step:' + s.dataset.step]);
  if (steps.length) showStep(fromHash || (Object.keys(since).length && firstOpen ? firstOpen.dataset.step : '') || state.at || steps[0].dataset.step, !!fromHash);

  // feedback on each item
  for (const box of document.querySelectorAll('.fb')) {
    const id = box.dataset.item, ta = box.querySelector('textarea');
    const paint = () => {
      const it = state.items[id];
      for (const b of box.querySelectorAll('button')) b.setAttribute('aria-pressed', String(!!it && it.v === b.dataset.v));
      ta.hidden = !it || it.v === 'ok';
      ta.placeholder = it && it.v === 'question' ? 'What is your question?' : 'What should change?';
      ta.value = (it && it.note) || '';
    };
    box.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]'); if (!b) return;
      const cur = state.items[id];
      if (cur && cur.v === b.dataset.v) delete state.items[id];
      else state.items[id] = { v: b.dataset.v, note: (cur && cur.note) || '', kind: box.dataset.kind, title: box.dataset.title };
      paint(); save();
      if (!ta.hidden) ta.focus();
      else if (box.dataset.kind === 'step' && state.items[id]) nextStep(box.closest('.step'));
    });
    ta.addEventListener('input', () => { if (state.items[id]) { state.items[id].note = ta.value; save(); } });
    paint();
  }
  // marks from an older version of this page, on items it no longer has, are dropped
  const onPage = new Set([...document.querySelectorAll('.fb')].map((b) => b.dataset.item));
  for (const k of Object.keys(state.items)) if (!onPage.has(k)) delete state.items[k];
  store.set(state);
  for (const r of document.querySelectorAll('input[name=verdict]')) {
    r.checked = r.value === state.verdict;
    r.addEventListener('change', () => { state.verdict = r.value; save(); });
  }
  const general = document.getElementById('general');
  general.value = state.general || '';
  general.addEventListener('input', () => { state.general = general.value; save(); });

  const VERDICT = { 'approve': 'Approve', 'approve-with-changes': 'Approve, with the changes marked', 'request-changes': 'Request changes', 'questions': 'Questions first' };
  const V = { ok: 'OK', question: 'Question', change: 'Change it' };
  const KIND = [['step', cfg.stepWord === 'step' ? 'Steps' : 'Parts'], ['why', 'Why'], ['picture', 'Pictures'], ['plan', 'Plan vs code'], ['risk', 'Risks'], ['option', 'Options']];
  function firstNo() {
    const i = steps.findIndex((s) => { const it = state.items['step:' + s.dataset.step]; return it && it.v === 'change'; });
    return i < 0 ? null : i + 1;
  }
  function asText() {
    const lines = ['Review of ' + cfg.pr + ' — ' + cfg.title, 'Verdict: ' + (VERDICT[state.verdict] || 'not chosen')];
    const stop = firstNo();
    if (stop) lines.push('Fix from ' + cfg.stepWord + ' ' + stop + ' on; ' + (stop > 1 ? cfg.stepWord + 's before it stand.' : 'start there.'));
    if (state.general.trim()) lines.push('', state.general.trim());
    for (const [k, label] of KIND) {
      const its = Object.entries(state.items).filter(([, it]) => it.kind === k);
      if (k === 'step') its.sort(([a], [b]) => stepIndex(a) - stepIndex(b));
      if (!its.length) continue;
      lines.push('', label + ':');
      for (const [id, it] of its) lines.push('- [' + V[it.v] + '] ' + it.title + ' (' + id.split(':').slice(1).join(':') + ')' + (it.note.trim() ? ': ' + it.note.trim() : ''));
    }
    return lines.join('\\n');
  }
  const status = document.getElementById('status');
  const say = (t, cls) => { status.textContent = t; status.className = cls || ''; };
  function tally() {
    const its = Object.values(state.items);
    const n = (v) => its.filter((i) => i.v === v).length;
    const good = steps.filter((s) => (state.items['step:' + s.dataset.step] || {}).v === 'ok').length;
    const stop = firstNo();
    document.getElementById('tally').textContent = [
      steps.length ? (good === steps.length ? 'All ' + steps.length + ' ' + cfg.stepWord + 's look good.' : good + ' of ' + steps.length + ' ' + cfg.stepWord + 's look good.') : '',
      stop ? 'Fix from ' + cfg.stepWord + ' ' + stop + ' on.' : '',
      its.length ? 'Marked: ' + n('ok') + ' OK, ' + n('question') + ' questions, ' + n('change') + ' changes.' : 'Mark each ' + cfg.stepWord + ' as you read; your marks are gathered here.',
    ].filter(Boolean).join(' ');
    for (const b of document.querySelectorAll('.strip button')) {
      const it = state.items['step:' + b.dataset.go];
      b.classList.toggle('ok', !!it && it.v === 'ok'); b.classList.toggle('question', !!it && it.v === 'question'); b.classList.toggle('change', !!it && it.v === 'change');
    }
  }
  tally();

  document.getElementById('copy').addEventListener('click', async () => {
    const t = asText();
    try { await navigator.clipboard.writeText(t); say('Copied. Paste it in a chat or a PR comment.', 'ok'); }
    catch { general.value = t; say('Could not copy automatically; the text is in the box above to copy by hand.', 'err'); }
  });

  const send = document.getElementById('send');
  if (send) send.addEventListener('click', async () => {
    if (!state.verdict) { say('Choose a verdict first.', 'err'); return; }
    const text = asText();
    if (cfg.noteLimit && text.length > cfg.noteLimit) { say('This review is ' + (text.length - cfg.noteLimit) + ' characters longer than the receiver keeps. Shorten a note, or use Copy as text.', 'err'); return; }
    const [mode, ...rest] = cfg.submit.split(':'); const url = rest.join(':');
    if (mode === 'form') {
      const f = document.createElement('form'); f.method = 'post'; f.action = url;
      for (const [k, v] of [['id', cfg.formId], ['answer', VERDICT[state.verdict]], ['note', text]]) { const i = document.createElement('input'); i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i); }
      document.body.appendChild(f); say('Sending…'); f.submit(); return;
    }
    send.disabled = true; say('Sending…');
    try {
      const answers = { verdict: state.verdict };
      for (const [id, it] of Object.entries(state.items)) answers[id] = it.v;
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page: cfg.formId, answers, comment: text, items: state.items }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      say('Sent. Thank you.', 'ok');
    } catch (e) { say('Not sent (' + e.message + '). Use Copy as text instead.', 'err'); }
    finally { send.disabled = false; }
  });

  // before / after tabs
  for (const fig of document.querySelectorAll('.viz')) {
    fig.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]'); if (!t) return;
      for (const b of fig.querySelectorAll('[data-tab]')) b.setAttribute('aria-selected', String(b === t));
      for (const p of fig.querySelectorAll('.panel')) p.hidden = p.dataset.panel !== t.dataset.tab;
    });
  }

  // diagrams: rendered when their layer opens (hidden diagrams measure wrong)
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && document.documentElement.dataset.theme !== 'light';
  const ready = typeof mermaid !== 'undefined';
  if (ready) mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'neutral', fontFamily: 'system-ui, sans-serif' });
  async function draw(scope) {
    if (!ready) return;
    const nodes = [...scope.querySelectorAll('pre.mermaid:not([data-processed])')].filter((n) => n.offsetParent !== null);
    if (nodes.length) { try { await mermaid.run({ nodes }); } catch (e) { console.warn(e); } }
    // keep diagrams at a readable size: a wide one scrolls sideways inside its box instead of shrinking
    for (const svg of scope.querySelectorAll('.canvas svg')) {
      const canvas = svg.closest('.canvas'); const w = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal.width : 0;
      if (!canvas || !w || canvas.clientWidth === 0) continue;
      // shrink to 75% of natural size at most (labels stay about 12px), then scroll
      const min = Math.round(w * 0.75), room = canvas.clientWidth - 16;
      const wide = min > room;
      svg.style.maxWidth = wide ? 'none' : ''; svg.style.width = wide ? min + 'px' : '';
      canvas.classList.toggle('wide', wide);
    }
  }
  for (const d of document.querySelectorAll('details.layer')) d.addEventListener('toggle', () => { if (d.open) draw(d); });
  for (const fig of document.querySelectorAll('.viz')) fig.addEventListener('click', (e) => { if (e.target.closest('[data-tab]')) draw(fig); });
  draw(document);
  if (location.hash) { const t = document.querySelector(location.hash); const d = t && t.closest('details.layer'); if (d) { d.open = true; } }
  for (const a of document.querySelectorAll('.rel a, .lookhere a')) a.addEventListener('click', () => { const t = document.querySelector(a.getAttribute('href')); const d = t && (t.matches('details') ? t : t.closest('details.layer')); if (d) d.open = true; });

  // full size
  const dlg = document.getElementById('zoom'), body = document.getElementById('zoom-body'), open = document.getElementById('zoom-open');
  let blobUrl = null;
  document.addEventListener('click', (e) => {
    const z = e.target.closest('.zoom'); if (!z) return;
    const fig = z.closest('.viz'); const panel = [...fig.querySelectorAll('.panel')].find((p) => !p.hidden);
    const svg = panel && panel.querySelector('svg');
    body.replaceChildren(svg ? svg.cloneNode(true) : document.createTextNode('The diagram has not been drawn (no connection to the diagram library?). Its source is shown on the page.'));
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (svg) { const bg = getComputedStyle(document.body).backgroundColor; const s = new XMLSerializer().serializeToString(svg).replace('<svg', '<svg style="background:' + bg + '"'); blobUrl = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' })); open.href = blobUrl; open.hidden = false; } else open.hidden = true;
    dlg.showModal();
  });
  document.getElementById('zoom-close').addEventListener('click', () => dlg.close());
})();
`;
