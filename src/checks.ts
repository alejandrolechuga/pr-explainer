// Runs the repo's tests at every commit of a PR, so the page can show which step broke something.
// It runs the PR's own code on this computer: only use it on PRs you trust.
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrContext } from "./context.js";

export interface CheckResult {
  sha: string;
  ok: boolean;
  seconds: number;
  /** the last lines of the output, for a failed run */
  tail: string;
}

export interface Checks {
  cmd: string;
  setup?: string;
  at: string;
  results: CheckResult[];
}

export interface CheckOptions {
  /** the repo to take the commits from */
  repoDir: string;
  cmd: string;
  /** runs before the first test, and again whenever a file in `setupWhen` changed */
  setup?: string;
  setupWhen?: string[];
  timeoutSeconds?: number;
  log?: (line: string) => void;
}

/** files whose change means dependencies must be installed again */
export const SETUP_WHEN = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "requirements.txt", "pyproject.toml", "poetry.lock", "Gemfile.lock", "go.sum", "Cargo.lock"];

const TAIL_LINES = 30;

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function hasCommit(dir: string, sha: string): boolean {
  try { git(dir, "cat-file", "-e", `${sha}^{commit}`); return true; } catch { return false; }
}

/** make sure every commit is in the local repo, fetching the PR's head from GitHub once if needed */
function ensureCommits(dir: string, ctx: PrContext, shas: string[]): void {
  if (shas.every((s) => hasCommit(dir, s))) return;
  if (ctx.pr.number) try { git(dir, "fetch", "-q", "origin", `pull/${ctx.pr.number}/head`); } catch { /* reported below */ }
  const missing = shas.filter((s) => !hasCommit(dir, s));
  if (missing.length) throw new Error(`commits not in ${dir}: ${missing.map((s) => s.slice(0, 7)).join(", ")} (run inside the PR's repo, or pass --dir)`);
}

function sh(cmd: string, cwd: string, timeoutSeconds: number): { ok: boolean; out: string } {
  const r = spawnSync("/bin/sh", ["-c", cmd], { cwd, encoding: "utf8", timeout: timeoutSeconds * 1000, maxBuffer: 64 * 1024 * 1024 });
  const timedOut = !!r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  if (timedOut) killLeftovers(cwd);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${timedOut ? `\nstopped after ${timeoutSeconds}s` : r.error ? `\n${r.error.message}` : ""}`;
  return { ok: r.status === 0 && !r.error, out };
}

/** a timeout stops the shell, not what it started (test workers, servers): stop what still uses the folder */
function killLeftovers(dir: string): void {
  let pids: number[] = [];
  try { pids = execFileSync("lsof", ["-t", "+D", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\n").map(Number).filter((n) => n > 0 && n !== process.pid); } catch { /* none, or no lsof */ }
  for (const pid of pids) try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/** folders kept between commits so dependencies are not installed again each time */
const KEEP = ["node_modules", ".venv", "venv", "vendor"];

const tailOf = (out: string) => out.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");

/** test every non-merge commit of the PR, oldest first, in a throwaway worktree */
export function runChecks(ctx: PrContext, o: CheckOptions): Checks {
  const log = o.log ?? (() => undefined);
  const shas = ctx.commits.filter((c) => !c.merge).map((c) => c.sha);
  if (!shas.length) throw new Error("this PR has no commits to test (merges are skipped)");
  ensureCommits(o.repoDir, ctx, shas);
  const tree = mkdtempSync(join(tmpdir(), "pr-explainer-checks-"));
  rmSync(tree, { recursive: true });
  git(o.repoDir, "worktree", "add", "-q", "--detach", tree, shas[0]!);
  const results: CheckResult[] = [];
  try {
    let prev: string | null = null;
    let needSetup = true;
    for (const sha of shas) {
      // a clean checkout: what setup or tests wrote at the last commit must not leak into this one
      git(tree, "checkout", "-q", "--force", "--detach", sha);
      git(tree, "clean", "-fdxq", ...KEEP.flatMap((k) => ["-e", k]));
      const started = Date.now();
      const changed = prev ? git(tree, "diff", "--name-only", prev, sha).split("\n") : [];
      let setupFailed: string | null = null;
      if (o.setup && (needSetup || changed.some((f) => (o.setupWhen ?? SETUP_WHEN).includes(f.split("/").pop() ?? "")))) {
        log(`${sha.slice(0, 7)}: setup`);
        const s = sh(o.setup, tree, o.timeoutSeconds ?? 600);
        if (!s.ok) setupFailed = `setup failed:\n${tailOf(s.out)}`;
        needSetup = !s.ok; // a failed setup is tried again at the next commit
      }
      const run = setupFailed ? { ok: false, out: setupFailed } : sh(o.cmd, tree, o.timeoutSeconds ?? 600);
      const seconds = Math.round((Date.now() - started) / 1000);
      log(`${sha.slice(0, 7)}: ${run.ok ? "pass" : "FAIL"} (${seconds}s)`);
      results.push({ sha, ok: run.ok, seconds, tail: run.ok ? "" : tailOf(run.out) });
      prev = sha;
    }
  } finally {
    try { git(o.repoDir, "worktree", "remove", "--force", tree); } catch { rmSync(tree, { recursive: true, force: true }); }
  }
  return { cmd: o.cmd, ...(o.setup ? { setup: o.setup } : {}), at: new Date().toISOString(), results };
}

export function writeChecks(workdir: string, c: Checks): void {
  writeFileSync(join(workdir, "checks.json"), JSON.stringify(c, null, 2));
}

export function readChecks(workdir: string): Checks | null {
  const f = join(workdir, "checks.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Checks) : null;
}
