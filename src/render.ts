// Turns a checked brief into one self-contained review page: the layers, rendered diagrams,
// a feedback control on every item, and a way to send the review back.
import { createHash } from "node:crypto";
import type { Brief, CitationT } from "./brief.js";
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

export function renderPage(brief: Brief, ctx: PrContext, files: DiffFile[], o: RenderOptions): string {
  const prUrl = ctx.pr.url;
  const fileUrl = (path: string, side?: "new" | "old", line?: number, end?: number): string | null => {
    if (!prUrl) return null;
    let a = `${prUrl}/files#${fileAnchor(path)}`;
    if (line) {
      const s = side === "old" ? "L" : "R";
      a += `${s}${line}${end && end !== line ? `-${s}${end}` : ""}`;
    }
    return a;
  };

  const rows = o.diffText ? diffRows(o.diffText) : new Map<string, Row[]>();
  const snippet = (c: Extract<CitationT, { kind: "code" }>): string | null => {
    const ex = excerpt(rows.get(c.file), c.side, c.line, c.endLine ?? c.line);
    if (!ex.rows.length) return null;
    const lo = c.line, hi = c.endLine ?? c.line;
    const label = `${c.file}:${lo}${hi !== lo ? `–${hi}` : ""}${c.side === "old" ? " (before)" : ""}`;
    const href = fileUrl(c.file, c.side, lo, hi);
    const colored = highlightLines(ex.rows.map((r) => r.text), c.file);
    const body = ex.rows.map((r, i) => {
      const n = c.side === "new" ? r.new : r.old;
      const hit = n !== undefined && n >= lo && n <= hi;
      const cls = r.kind === "+" ? "row-add" : r.kind === "-" ? "row-del" : "row-ctx";
      return `<tr class="${cls}${hit ? " hit" : ""}"><td class="ln">${r.kind === "-" ? r.old : r.new}</td><td class="mk">${r.kind === " " ? "" : r.kind === "-" ? "−" : "+"}</td><td class="tx">${colored[i] || " "}</td></tr>`;
    }).join("");
    return `<details class="snip" open><summary><span class="file">${esc(label)}</span>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">GitHub ↗</a>` : ""}</summary>
      <div class="code"><table>${body}</table></div>${ex.more ? `<p class="more">${ex.more} more line${ex.more === 1 ? "" : "s"}${href ? ` — <a href="${esc(href)}" target="_blank" rel="noopener">see all on GitHub</a>` : ""}</p>` : ""}</details>`;
  };

  const cite = (c: CitationT): string => {
    if (c.kind === "code") {
      const label = `${c.file}:${c.line}${c.endLine && c.endLine !== c.line ? `–${c.endLine}` : ""}${c.side === "old" ? " (before)" : ""}`;
      const href = fileUrl(c.file, c.side, c.line, c.endLine);
      return href ? `<a class="cite" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>` : `<span class="cite">${esc(label)}</span>`;
    }
    const from = SOURCE_LABEL[c.source] ?? c.source;
    const ref = c.ref ? ` ${c.source === "commit" ? c.ref.slice(0, 7) : c.ref}` : "";
    return `<span class="quote"><q>${esc(c.quote)}</q> <span class="src">— ${esc(from + ref)}</span></span>`;
  };
  const cites = (cs: CitationT[]): string => {
    const quotes = cs.filter((c) => c.kind === "source").map(cite).join("");
    const codeCs = cs.filter((c): c is Extract<CitationT, { kind: "code" }> => c.kind === "code");
    const snips = codeCs.map((c) => snippet(c));
    const shown = snips.filter((x): x is string => !!x).join("");
    const chips = codeCs.filter((_, i) => !snips[i]).map(cite).join("");
    return `${quotes ? `<div class="quotes">${quotes}</div>` : ""}${shown ? `<div class="snips">${shown}</div>` : ""}${chips ? `<div class="cites">${chips}</div>` : ""}`;
  };

  const basis = (b: "stated" | "inferred"): string =>
    b === "stated"
      ? `<span class="badge stated" title="The author wrote this down; the quote is checked against their words">Stated by the author</span>`
      : `<span class="badge guess" title="Not written down by the author; this is a reading of the code">Our reading — a guess</span>`;

  const riskPill = (r: "low" | "medium" | "high", word = "risk"): string => `<span class="pill ${r}">${r} ${word}</span>`;

  const fb = (kind: string, id: string, title: string): string =>
    `<div class="fb" data-item="${esc(`${kind}:${id}`)}" data-kind="${esc(kind)}" data-title="${esc(title)}">
      <div class="fb-buttons" role="group" aria-label="Your feedback on this">
        <button type="button" data-v="ok" aria-pressed="false">OK</button>
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

  const layer = (id: string, n: number, title: string, meta: string, body: string, open: boolean): string =>
    `<details class="layer" id="${id}"${open ? " open" : ""}>
      <summary><span class="n">${n}</span><span class="t">${esc(title)}</span><span class="meta">${esc(meta)}</span></summary>
      <div class="layer-body">${body}</div>
    </details>`;

  const summaryBody = `
    ${ctx.intentRecord ? "" : `<p class="callout">This PR has no intent record, so any reason marked <b>a guess</b> is a reading of the code, not the author's words.</p>`}
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

  const mapBody = `<ol class="slices">${slices.map((s) => {
    const list = s.files.map((p) => {
      const f = byPath.get(p);
      const href = fileUrl(p);
      const stat = f ? `<span class="stat"><span class="add">+${f.added}</span> <span class="del">−${f.removed}</span></span>` : "";
      return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(p)}</a>` : esc(p)} ${stat}</li>`;
    }).join("");
    return `<li class="slice" id="slice-${esc(s.id)}">
      <div class="row"><h4>${esc(s.title)}</h4>${riskPill(s.risk)}</div>
      <p>${esc(s.summary)}</p>
      <details class="files"><summary>${s.files.length} file${s.files.length === 1 ? "" : "s"}</summary><ul>${list}</ul></details>
      ${fb("slice", s.id, s.title)}
    </li>`;
  }).join("")}</ol>`;

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

  const nav = [
    ["summary", "Summary"], ["map", "Reading map"], ["why", "Why"], ["pictures", "Pictures"],
    ["plan", "Plan vs code"], ["risks", "Risks"], ["options", "Options"], ["review", "Your review"],
  ].map(([id, l]) => `<a href="#${id}">${l}</a>`).join("");

  const highRisks = brief.risks.filter((r) => r.severity === "high").length;
  const config = {
    formId: o.formId,
    submit: o.submit ?? null,
    noteLimit: o.noteLimit ?? null,
    pr: `${ctx.repo}${ctx.pr.number ? `#${ctx.pr.number}` : ` (${ctx.pr.head})`}`,
    title: brief.pr.title,
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
<nav class="layers" aria-label="Layers"><div>${nav}</div></nav>
<main>
${layer("summary", 1, "In 30 seconds", `${brief.beforeAfter.length} changes`, summaryBody, true)}
${layer("map", 2, "Reading map", `${slices.length} slices, read in this order`, mapBody, true)}
${layer("why", 3, "Why it was done this way", `${brief.decisions.length} decisions${guesses ? `, ${guesses} guessed` : ""}`, whyBody, false)}
${layer("pictures", 4, "Pictures", `${brief.visuals.length} diagram${brief.visuals.length === 1 ? "" : "s"}`, picsBody, false)}
${layer("plan", 5, "Plan vs code", brief.mismatches.length ? `${brief.mismatches.length} difference${brief.mismatches.length === 1 ? "" : "s"}` : "none found", planBody, brief.mismatches.length > 0)}
${layer("risks", 6, "What could go wrong", riskMeta(risks), risksBody, false)}
${layer("options", 7, "What we could change", `${brief.options.length} option${brief.options.length === 1 ? "" : "s"}`, optionsBody, false)}
<section class="layer review" id="review"><h2>Your review</h2>${reviewBody}</section>
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
nav.layers{position:sticky;top:0;z-index:5;background:color-mix(in srgb,var(--bg) 92%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line);padding:8px 16px}
nav.layers>div{max-width:780px;margin:0 auto;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
nav.layers>div::-webkit-scrollbar{display:none}
nav a{flex:none;font-size:13px;text-decoration:none;color:var(--ink);border:1px solid var(--line);background:var(--surface);border-radius:999px;padding:5px 11px}
main{max-width:780px;margin:0 auto;padding:16px}
.layer{background:var(--surface);border:1px solid var(--line);border-radius:12px;margin:0 0 14px;scroll-margin-top:60px}
.layer>summary{list-style:none;cursor:pointer;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px;padding:14px 16px}
.layer>summary::-webkit-details-marker{display:none}
.layer>summary .n{flex:none;width:24px;height:24px;border-radius:50%;background:var(--ink);color:var(--bg);font-size:13px;display:inline-grid;place-items:center;transform:translateY(-1px)}
.layer>summary .t{font-weight:650;font-size:17px}
.layer>summary .meta{color:var(--muted);font-size:13px;margin-left:auto}
.layer:not([open])>summary .meta::after{content:" ▸"}
.layer-body{padding:0 16px 16px}
.review{padding:14px 16px 18px}.review h2{font-size:17px;margin:0 0 8px}
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
  const state = Object.assign({ items: {}, verdict: '', general: '' }, store.get());
  const save = () => { store.set(state); tally(); };

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
    });
    ta.addEventListener('input', () => { if (state.items[id]) { state.items[id].note = ta.value; save(); } });
    paint();
  }
  for (const r of document.querySelectorAll('input[name=verdict]')) {
    r.checked = r.value === state.verdict;
    r.addEventListener('change', () => { state.verdict = r.value; save(); });
  }
  const general = document.getElementById('general');
  general.value = state.general || '';
  general.addEventListener('input', () => { state.general = general.value; save(); });

  const VERDICT = { 'approve': 'Approve', 'approve-with-changes': 'Approve, with the changes marked', 'request-changes': 'Request changes', 'questions': 'Questions first' };
  const V = { ok: 'OK', question: 'Question', change: 'Change it' };
  const KIND = [['slice', 'Reading map'], ['why', 'Why'], ['picture', 'Pictures'], ['plan', 'Plan vs code'], ['risk', 'Risks'], ['option', 'Options']];
  function asText() {
    const lines = ['Review of ' + cfg.pr + ' — ' + cfg.title, 'Verdict: ' + (VERDICT[state.verdict] || 'not chosen')];
    if (state.general.trim()) lines.push('', state.general.trim());
    for (const [k, label] of KIND) {
      const its = Object.entries(state.items).filter(([, it]) => it.kind === k);
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
    document.getElementById('tally').textContent = its.length
      ? 'Marked so far: ' + n('ok') + ' OK, ' + n('question') + ' questions, ' + n('change') + ' changes.'
      : 'Mark items above with OK, Question or Change it; they are gathered here.';
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
  for (const a of document.querySelectorAll('nav a, .rel a')) a.addEventListener('click', () => { const t = document.querySelector(a.getAttribute('href')); const d = t && (t.matches('details') ? t : t.closest('details.layer')); if (d) d.open = true; });

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
