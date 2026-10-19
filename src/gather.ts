// Collects the diff and everything that explains it: PR body, intent record, commits, decision docs.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrContext } from "./context.js";
import { extractIntentRecord, findIssueRefs } from "./intent.js";

const MAX_DOCS = 12;
const MAX_DOC_BYTES = 60_000;

const DOC_PATTERNS = [
  /^(README|CONTEXT|HANDOFF|STATUS|DECISIONS|VALIDATION|ARCHITECTURE|CLAUDE)\.md$/i,
  /^\.claude\/handoff\.md$/i,
  /^docs\/.*\.md$/i,
  /(^|\/)adrs?\/.*\.md$/i,
];

export function isDocPath(p: string): boolean {
  return DOC_PATTERNS.some((re) => re.test(p));
}

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

function pickDocs(paths: string[]): string[] {
  // Top-level docs first, then docs/ and ADRs, shortest paths first.
  return paths.filter(isDocPath).sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, MAX_DOCS);
}

export interface Gathered {
  context: PrContext;
  diff: string;
  slug: string;
}

export function gatherPr(prRef: string, repoArg?: string): Gathered {
  const repo = repoArg ?? run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  const pr = JSON.parse(run("gh", [
    "pr", "view", prRef, "--repo", repo,
    "--json", "number,title,body,baseRefName,headRefName,headRefOid,baseRefOid,url,commits",
  ])) as {
    number: number; title: string; body: string; baseRefName: string; headRefName: string;
    headRefOid: string; baseRefOid: string; url: string; commits: { oid: string; messageHeadline: string; messageBody: string }[];
  };
  const diff = run("gh", ["pr", "diff", String(pr.number), "--repo", repo]);

  const tree = run("gh", ["api", `repos/${repo}/git/trees/${pr.headRefOid}?recursive=1`, "--jq", '.tree[] | select(.type=="blob") | .path'])
    .split("\n").filter(Boolean);
  const docs = pickDocs(tree).map((path) => ({
    path,
    text: run("gh", ["api", `repos/${repo}/contents/${encodeURI(path)}?ref=${pr.headRefOid}`, "-H", "Accept: application/vnd.github.raw"]).slice(0, MAX_DOC_BYTES),
  }));

  const commits = pr.commits.map((c) => ({ sha: c.oid, message: `${c.messageHeadline}\n\n${c.messageBody}`.trim() }));
  const body = pr.body ?? "";
  const context: PrContext = {
    version: 1,
    repo,
    pr: { number: pr.number, title: pr.title, base: pr.baseRefName, head: pr.headRefName, url: pr.url, headSha: pr.headRefOid, baseSha: pr.baseRefOid },
    body,
    intentRecord: extractIntentRecord(body),
    commits,
    issueRefs: findIssueRefs(pr.title, body, pr.headRefName, ...commits.map((c) => c.message)),
    issues: [],
    docs,
  };
  return { context, diff, slug: `${repo.replace("/", "-")}-${pr.number}` };
}

export function gatherLocal(base: string, cwd: string): Gathered {
  const root = run("git", ["rev-parse", "--show-toplevel"], cwd).trim();
  const head = run("git", ["rev-parse", "--abbrev-ref", "HEAD"], root).trim();
  let repo = root.split("/").pop() ?? "repo";
  try {
    const url = run("git", ["remote", "get-url", "origin"], root).trim();
    repo = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? repo;
  } catch { /* no remote */ }

  const diff = run("git", ["diff", `${base}...HEAD`], root);
  const log = run("git", ["log", "--format=%H%x00%B%x1e", `${base}..HEAD`], root);
  const commits = log.split("\x1e").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [sha = "", message = ""] = s.split("\x00");
    return { sha, message: message.trim() };
  });
  const tracked = run("git", ["ls-files"], root).split("\n").filter(Boolean);
  const docs = pickDocs(tracked)
    .filter((p) => existsSync(join(root, p)))
    .map((path) => ({ path, text: readFileSync(join(root, path), "utf8").slice(0, MAX_DOC_BYTES) }));

  const context: PrContext = {
    version: 1,
    repo,
    pr: { title: commits.at(-1)?.message.split("\n")[0] ?? head, base, head },
    body: "",
    intentRecord: null,
    commits,
    issueRefs: findIssueRefs(head, ...commits.map((c) => c.message)),
    issues: [],
    docs,
  };
  return { context, diff, slug: `${repo.replace("/", "-")}-${head.replace(/[^\w.-]+/g, "_")}` };
}
