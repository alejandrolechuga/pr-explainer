// pr-explainer: gather | validate | schema | template
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { briefJsonSchema } from "./brief.js";
import type { PrContext } from "./context.js";
import { annotateDiff, parseDiff } from "./diff.js";
import { findCommit, readCommitDiffs, writeCommitDiffs } from "./commits.js";
import { readChecks, runChecks, writeChecks } from "./checks.js";
import { fillCommand, loadConfig, configPath } from "./config.js";
import { gatherLocal, gatherPr } from "./gather.js";
import { formIdFor, renderPage } from "./render.js";
import { BriefSchema } from "./brief.js";
import { execFileSync, execSync } from "node:child_process";
import { createServer } from "node:http";
import { formatReport, validateBrief } from "./validate.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** where work folders go: $PR_EXPLAINER_HOME, else the user's cache folder */
const WORK = process.env.PR_EXPLAINER_HOME ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "pr-explainer");
const SKILL_DIR = join(homedir(), ".claude", "skills", "explain-pr");

/** main() result for a command that keeps running (serve) */
const KEEP_RUNNING = -1;

const USAGE = `pr-explainer <command>

  gather <pr-number|url> [--repo owner/name]   collect a GitHub PR (run inside its repo, or pass --repo)
  gather --base <ref>                          collect the current branch against <ref>, no PR needed
  lines <workdir> [file] [--commit <sha>]      print the diff with old/new line numbers (for exact citations);
                                               --commit: one commit's own diff (for a step's citations)
  render <workdir> [--submit json:<url>|form:<url>] [--form-id <id>] [--publish] [--open]
                                               build <workdir>/page/index.html (refuses a brief that fails validate)
  serve <workdir> [--port 7700] [--no-open]    show the page on this computer; Send saves to <workdir>/answers.jsonl
  answers <workdir|form-id>                    print feedback sent from the page (needs "answersFile" in settings)
  test-steps <workdir> --cmd "<test command>" [--setup "<install command>"] [--dir <repo>] [--timeout <seconds>]
                                               run the tests at every commit (in a throwaway worktree) and save
                                               <workdir>/checks.json; the page shows pass/fail per step.
                                               It runs the PR's code on this computer: only for PRs you trust.
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
    options: { cmd: { type: "string" }, setup: { type: "string" }, timeout: { type: "string" }, commit: { type: "string" }, repo: { type: "string" }, base: { type: "string" }, json: { type: "boolean" }, dir: { type: "string" }, submit: { type: "string" }, "form-id": { type: "string" }, publish: { type: "boolean" }, open: { type: "boolean" }, port: { type: "string" }, "no-open": { type: "boolean" } },
  });

  switch (cmd) {
    case "gather": {
      const g = values.base ? gatherLocal(values.base, process.cwd()) : positionals[0] ? gatherPr(positionals[0], values.repo) : null;
      if (!g) { console.error(USAGE); return 2; }
      const dir = join(WORK, g.slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "context.json"), JSON.stringify(g.context, null, 2));
      writeFileSync(join(dir, "diff.patch"), g.diff);
      writeCommitDiffs(dir, g.commitDiffs);
      const files = parseDiff(g.diff);
      const added = files.reduce((n, f) => n + f.added, 0);
      const removed = files.reduce((n, f) => n + f.removed, 0);
      console.log([
        `workdir: ${dir}`,
        `pr: ${g.context.pr.title} (${g.context.pr.head} -> ${g.context.pr.base})`,
        `files: ${files.length} changed, +${added} -${removed}`,
        `intent record: ${g.context.intentRecord ? "found" : "MISSING (whys will be guesses unless quoted elsewhere)"}`,
        `commits: ${g.context.commits.length} (oldest first)`,
        ...g.context.commits.map((c, i) => `  ${i + 1}. ${c.sha.slice(0, 7)} ${c.message.split("\n")[0]}${c.merge ? "  (merge: not a step)" : g.commitDiffs.some((d) => d.sha === c.sha) ? "" : "  (GitHub gave no diff for it)"}`),
        `issue refs: ${g.context.issueRefs.join(", ") || "none"}`,
        `docs: ${g.context.docs.map((d) => d.path).join(", ") || "none"}`,
      ].join("\n"));
      return 0;
    }
    case "lines": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      if (values.commit) {
        const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as PrContext;
        const hit = findCommit(ctx.commits, values.commit);
        if (typeof hit === "string") { console.error(hit); return 1; }
        const saved = readCommitDiffs(dir, ctx).find((d) => d.sha === hit.sha);
        if (!saved) { console.error(`no saved diff for ${values.commit}; run gather again`); return 1; }
        console.log(annotateDiff(saved.text, positionals[1]));
        return 0;
      }
      console.log(annotateDiff(readFileSync(join(dir, "diff.patch"), "utf8"), positionals[1]));
      return 0;
    }
    case "test-steps": {
      const dir = positionals[0];
      if (!dir || !values.cmd) { console.error(USAGE); return 2; }
      if (values.timeout && !/^[1-9]\d*$/.test(values.timeout)) { console.error("--timeout: whole seconds, e.g. 600"); return 2; }
      const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as PrContext;
      const checks = runChecks(ctx, {
        repoDir: resolve(values.dir ?? process.cwd()),
        cmd: values.cmd,
        ...(values.setup ? { setup: values.setup } : {}),
        ...(values.timeout ? { timeoutSeconds: Number(values.timeout) } : {}),
        log: (l) => console.log(l),
      });
      writeChecks(dir, checks);
      const failed = checks.results.filter((r) => !r.ok).length;
      console.log(`${checks.results.length - failed} of ${checks.results.length} commits pass; saved ${join(dir, "checks.json")}`);
      return 0;
    }
    case "validate": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as PrContext;
      const diffText = readFileSync(join(dir, "diff.patch"), "utf8");
      const files = parseDiff(diffText);
      const brief = JSON.parse(readFileSync(join(dir, "brief.json"), "utf8")) as unknown;
      const report = validateBrief(brief, files, ctx, diffText, readCommitDiffs(dir, ctx));
      if (values.json) console.log(JSON.stringify({ ...report, brief: undefined }, null, 2));
      else console.log(formatReport(report));
      return report.ok ? 0 : 1;
    }
    case "render": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      const cfg = loadConfig();
      const submit = values.submit ?? cfg.submit;
      const r = renderTo(dir, submit, values["form-id"]);
      if (typeof r === "number") return r;
      console.log(`page: ${r.file}\nfeedback id: ${r.formId}\nsend: ${submit ?? "copy only (no submit configured)"}`);
      if (values.publish) {
        if (!cfg.publishCommand) { console.error(`--publish needs "publishCommand" in ${configPath()}`); return 1; }
        const cmd = fillCommand(cfg.publishCommand, { name: r.formId, dir: dirname(r.file), file: r.file });
        console.log(execSync(cmd, { encoding: "utf8", shell: "/bin/sh" }).trim());
      }
      if (values.open) openInBrowser(r.file);
      return 0;
    }
    case "serve": {
      const dir = positionals[0];
      if (!dir) { console.error(USAGE); return 2; }
      const r = renderTo(dir, "json:/feedback", values["form-id"]);
      if (typeof r === "number") return r;
      const answers = join(dir, "answers.jsonl");
      const server = createServer((req, res) => {
        if (req.method === "POST" && req.url === "/feedback") {
          let body = "";
          req.on("data", (c: Buffer) => { body += c; if (body.length > 256_000) req.destroy(); });
          req.on("end", () => {
            try {
              const e = JSON.parse(body) as { page?: string; answers?: Record<string, string>; comment?: string };
              appendFileSync(answers, `${JSON.stringify({ at: new Date().toISOString(), page: e.page, answer: e.answers?.verdict, answers: e.answers, note: e.comment })}\n`);
              res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
              console.log(`feedback saved to ${answers}`);
            } catch { res.writeHead(400).end("bad json"); }
          });
          return;
        }
        if (req.method === "GET" && (req.url === "/" || req.url?.startsWith("/?"))) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(readFileSync(r.file));
          return;
        }
        res.writeHead(404).end("not found");
      });
      const port = Number(values.port ?? 7700);
      server.listen(port, "127.0.0.1", () => {
        const url = `http://127.0.0.1:${port}/`;
        console.log(`review page: ${url}\nSend saves to ${answers}\nCtrl-C to stop`);
        if (!values["no-open"]) openInBrowser(url);
      });
      return KEEP_RUNNING;
    }
    case "answers": {
      const which = positionals[0];
      if (!which) { console.error(USAGE); return 2; }
      const cfg = loadConfig();
      const local = existsSync(join(which, "answers.jsonl")) ? join(which, "answers.jsonl") : null;
      if (!cfg.answersFile && !local) { console.error(`no feedback file: use \`serve\`, set "answersFile" in ${configPath()}, or ask the reviewer to use Copy as text`); return 1; }
      const formId = existsSync(join(which, "context.json"))
        ? values["form-id"] ?? formIdFor(JSON.parse(readFileSync(join(which, "context.json"), "utf8")) as PrContext, cfg.formIdPrefix)
        : which;
      const read = (f?: string) => { const p = f?.replace(/^~(?=\/)/, homedir()); return p && existsSync(p) ? readFileSync(p, "utf8") : ""; };
      const hits = `${read(local ?? undefined)}\n${read(cfg.answersFile)}`.split("\n").filter(Boolean).flatMap((l) => {
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

/** render a workdir's page; a number is an exit code */
function renderTo(dir: string, submit: string | undefined, formIdArg: string | undefined): { file: string; formId: string } | number {
  const cfg = loadConfig();
  const ctx = JSON.parse(readFileSync(join(dir, "context.json"), "utf8")) as PrContext;
  const diffText = readFileSync(join(dir, "diff.patch"), "utf8");
  const files = parseDiff(diffText);
  const raw = JSON.parse(readFileSync(join(dir, "brief.json"), "utf8")) as unknown;
  const commitDiffs = readCommitDiffs(dir, ctx);
  const report = validateBrief(raw, files, ctx, diffText, commitDiffs);
  if (!report.ok) { console.error(formatReport(report)); console.error("not rendered: fix the errors first"); return 1; }
  if (submit && !/^(json|form):\S+$/.test(submit)) { console.error('--submit must look like "json:<url>" or "form:<url>"'); return 2; }
  const formId = formIdArg ?? formIdFor(ctx, cfg.formIdPrefix);
  if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(formId)) { console.error("--form-id: lowercase letters, digits and dashes"); return 2; }
  const html = renderPage(BriefSchema.parse(raw), ctx, files, {
    formId,
    ...(submit ? { submit } : {}),
    ...(cfg.noteLimit ? { noteLimit: cfg.noteLimit } : {}),
    warnings: report.findings.map((f) => f.message),
    diffText,
    commitDiffs,
    checks: readChecks(dir),
  });
  const out = join(dir, "page");
  mkdirSync(out, { recursive: true });
  const file = join(out, "index.html");
  writeFileSync(file, html);
  return { file, formId };
}

function openInBrowser(target: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]] : ["xdg-open", [target]];
  try { execFileSync(cmd as string, args as string[], { stdio: "ignore" }); } catch { console.log(`open ${target} in a browser`); }
}

function isLink(p: string): boolean {
  try { return lstatSync(p).isSymbolicLink(); } catch { return false; }
}

try {
  const code = main(process.argv.slice(2));
  if (code !== KEEP_RUNNING) process.exitCode = code;
} catch (e) {
  const err = e as { stderr?: string; message: string };
  console.error(err.stderr?.trim() || err.message);
  process.exitCode = 1;
}
