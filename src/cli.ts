// pr-explainer: gather | validate | schema | template
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { briefJsonSchema } from "./brief.js";
import type { PrContext } from "./context.js";
import { annotateDiff, parseDiff } from "./diff.js";
import { fillCommand, loadConfig, configPath } from "./config.js";
import { gatherLocal, gatherPr } from "./gather.js";
import { formIdFor, renderPage } from "./render.js";
import { BriefSchema } from "./brief.js";
import { execSync } from "node:child_process";
import { formatReport, validateBrief } from "./validate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** where work folders go: $PR_EXPLAINER_HOME, else the user's cache folder */
const WORK = process.env.PR_EXPLAINER_HOME ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pr-explainer");
const SKILL_DIR = join(homedir(), ".claude", "skills", "explain-pr");

const USAGE = `pr-explainer <command>

  gather <pr-number|url> [--repo owner/name]   collect a GitHub PR (run inside its repo, or pass --repo)
  gather --base <ref>                          collect the current branch against <ref>, no PR needed
  lines <workdir> [file]                       print the diff with old/new line numbers (for exact citations)
  render <workdir> [--submit json:<url>|form:<url>] [--form-id <id>] [--publish]
                                               build <workdir>/page/index.html (refuses a brief that fails validate)
  answers <workdir|form-id>                    print feedback sent from the page (needs "answersFile" in settings)
  validate <workdir>                           check <workdir>/brief.json against the diff and context
  schema                                       print the brief's JSON schema
  template                                     print the intent record template for PR bodies
  install-skill [--dir <path>]                 link the explain-pr skill into Claude Code (default ~/.claude/skills/explain-pr)

Work folders live in ${WORK}/<repo>-<pr>/ (set PR_EXPLAINER_HOME to change).
Personal settings (submit, publishCommand…): ${configPath()}`;

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { repo: { type: "string" }, base: { type: "string" }, json: { type: "boolean" }, dir: { type: "string" }, submit: { type: "string" }, "form-id": { type: "string" }, publish: { type: "boolean" } },
  });

  switch (cmd) {
    case "gather": {
      const g = values.base ? gatherLocal(values.base, process.cwd()) : positionals[0] ? gatherPr(positionals[0], values.repo) : null;
      if (!g) { console.error(USAGE); return 2; }
      const dir = join(WORK, g.slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "context.json"), JSON.stringify(g.context, null, 2));
      writeFileSync(join(dir, "diff.patch"), g.diff);
      const files = parseDiff(g.diff);
      const added = files.reduce((n, f) => n + f.added, 0);
      const removed = files.reduce((n, f) => n + f.removed, 0);
      console.log([
        `workdir: ${dir}`,
        `pr: ${g.context.pr.title} (${g.context.pr.head} -> ${g.context.pr.base})`,
        `files: ${files.length} changed, +${added} -${removed}`,
        `intent record: ${g.context.intentRecord ? "found" : "MISSING (whys will be guesses unless quoted elsewhere)"}`,
        `commits: ${g.context.commits.length}`,
        `issue refs: ${g.context.issueRefs.join(", ") || "none"}`,
        `docs: ${g.context.docs.map((d) => d.path).join(", ") || "none"}`,
      ].join("\n"));
      return 0;
    }
    case "lines": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      console.log(annotateDiff(readFileSync(join(dir, "diff.patch"), "utf8"), positionals[1]));
      return 0;
    }
    case "validate": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as PrContext;
      const diffText = readFileSync(join(dir, "diff.patch"), "utf8");
      const files = parseDiff(diffText);
      const brief = JSON.parse(readFileSync(join(dir, "brief.json"), "utf8")) as unknown;
      const report = validateBrief(brief, files, ctx, diffText);
      if (values.json) console.log(JSON.stringify({ ...report, brief: undefined }, null, 2));
      else console.log(formatReport(report));
      return report.ok ? 0 : 1;
    }
    case "render": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      const cfg = loadConfig();
      const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as PrContext;
      const diffText = readFileSync(join(dir, "diff.patch"), "utf8");
      const files = parseDiff(diffText);
      const raw = JSON.parse(readFileSync(join(dir, "brief.json"), "utf8")) as unknown;
      const report = validateBrief(raw, files, ctx, diffText);
      if (!report.ok) { console.error(formatReport(report)); console.error("not rendered: fix the errors first"); return 1; }
      const submit = values.submit ?? cfg.submit;
      if (submit && !/^(json|form):\S+$/.test(submit)) { console.error('--submit must look like "json:<url>" or "form:<url>"'); return 2; }
      const formId = values["form-id"] ?? formIdFor(ctx, cfg.formIdPrefix);
      if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(formId)) { console.error("--form-id: lowercase letters, digits and dashes"); return 2; }
      const html = renderPage(BriefSchema.parse(raw), ctx, files, {
        formId,
        ...(submit ? { submit } : {}),
        ...(cfg.noteLimit ? { noteLimit: cfg.noteLimit } : {}),
        warnings: report.findings.map((f) => f.message),
      });
      const out = join(dir, "page");
      mkdirSync(out, { recursive: true });
      const file = join(out, "index.html");
      writeFileSync(file, html);
      console.log(`page: ${file}\nfeedback id: ${formId}\nsend: ${submit ?? "copy only (no submit configured)"}`);
      if (values.publish) {
        if (!cfg.publishCommand) { console.error(`--publish needs "publishCommand" in ${configPath()}`); return 1; }
        const cmd = fillCommand(cfg.publishCommand, { name: formId, dir: out, file });
        console.log(execSync(cmd, { encoding: "utf8", shell: "/bin/sh" }).trim());
      }
      return 0;
    }
    case "answers": {
      const which = positionals[0];
      if (!which) { console.error(USAGE); return 2; }
      const cfg = loadConfig();
      if (!cfg.answersFile) { console.error(`no "answersFile" in ${configPath()}; ask the reviewer to use Copy as text`); return 1; }
      const formId = existsSync(join(which, "context.json"))
        ? values["form-id"] ?? formIdFor(JSON.parse(readFileSync(join(which, "context.json"), "utf8")) as PrContext, cfg.formIdPrefix)
        : which;
      const file = cfg.answersFile.replace(/^~(?=\/)/, homedir());
      const hits = (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").filter(Boolean).flatMap((l) => {
        try { const e = JSON.parse(l) as Record<string, unknown>; return e.id === formId || e.page === formId ? [e] : []; } catch { return []; }
      });
      if (!hits.length) { console.log(`no feedback yet for ${formId}`); return 0; }
      for (const e of hits) console.log(`--- ${String(e.at ?? "")}\n${String(e.note ?? e.comment ?? "")}${e.answer ? `\n(verdict: ${String(e.answer)})` : ""}`);
      return 0;
    }
    case "schema":
      console.log(JSON.stringify(briefJsonSchema(), null, 2));
      return 0;
    case "template":
      console.log(readFileSync(join(ROOT, "templates", "intent-record.md"), "utf8"));
      return 0;
    case "install-skill": {
      const target = values.dir ?? SKILL_DIR;
      const source = join(ROOT, "skill");
      if (existsSync(target) || isLink(target)) {
        if (!isLink(target)) { console.error(`${target} exists and is not a link; remove it first`); return 1; }
        rmSync(target);
      }
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
      console.log(`linked ${target} -> ${source}`);
      return 0;
    }
    default:
      console.error(USAGE);
      return cmd ? 2 : 0;
  }
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  const err = e as { stderr?: string; message: string };
  console.error(err.stderr?.trim() || err.message);
  process.exitCode = 1;
}
