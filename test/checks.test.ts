import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runChecks } from "../src/checks.js";
import type { PrContext } from "../src/context.js";

/** a repo whose second commit breaks the test, and whose third fixes it */
function repo(): { dir: string; shas: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "pe-checks-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  const commit = (value: string, msg: string) => {
    writeFileSync(join(dir, "value.txt"), value);
    git("add", "-A");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", msg);
    return git("rev-parse", "HEAD");
  };
  return { dir, shas: [commit("good", "one"), commit("bad", "two"), commit("good", "three")] };
}

describe("runChecks", () => {
  it("runs the tests at every commit and keeps the output of a failure", () => {
    const { dir, shas } = repo();
    const ctx = { version: 1, repo: "t", pr: { title: "t", base: "main", head: "x" }, body: "", intentRecord: null, commits: shas.map((sha) => ({ sha, message: "m" })), issueRefs: [], issues: [], docs: [] } as PrContext;
    const c = runChecks(ctx, { repoDir: dir, cmd: 'echo checking; grep -q good value.txt || { echo "value is bad"; exit 1; }' });
    expect(c.results.map((r) => r.ok)).toEqual([true, false, true]);
    expect(c.results[1]!.tail).toContain("value is bad");
    expect(c.results[0]!.tail).toBe("");
    expect(execFileSync("git", ["worktree", "list"], { cwd: dir, encoding: "utf8" }).trim().split("\n")).toHaveLength(1);
  });

  it("counts a failed setup as a failed step", () => {
    const { dir, shas } = repo();
    const ctx = { version: 1, repo: "t", pr: { title: "t", base: "main", head: "x" }, body: "", intentRecord: null, commits: shas.slice(0, 1).map((sha) => ({ sha, message: "m" })), issueRefs: [], issues: [], docs: [] } as PrContext;
    const c = runChecks(ctx, { repoDir: dir, cmd: "true", setup: "echo no network; exit 3" });
    expect(c.results[0]!.ok).toBe(false);
    expect(c.results[0]!.tail).toMatch(/setup failed:\nno network/);
  });

  it("says which commits are missing", () => {
    const { dir } = repo();
    const ctx = { version: 1, repo: "t", pr: { title: "t", base: "main", head: "x" }, body: "", intentRecord: null, commits: [{ sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", message: "m" }], issueRefs: [], issues: [], docs: [] } as PrContext;
    expect(() => runChecks(ctx, { repoDir: dir, cmd: "true" })).toThrow(/commits not in .*: deadbee/);
  });
});
