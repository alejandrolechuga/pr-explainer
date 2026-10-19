// Parses a unified diff (from `gh pr diff` or `git diff`) into files and hunks.

export type FileStatus = "added" | "deleted" | "modified" | "renamed";

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
}

export interface DiffFile {
  path: string; // new path; old path for deleted files
  oldPath: string;
  status: FileStatus;
  binary: boolean;
  added: number;
  removed: number;
  hunks: Hunk[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, "");
}

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let inHunk = false;

  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      const oldPath = m?.[1] ?? "";
      const newPath = m?.[2] ?? oldPath;
      cur = { path: newPath, oldPath, status: "modified", binary: false, added: 0, removed: 0, hunks: [] };
      files.push(cur);
      inHunk = false;
      continue;
    }
    if (!cur) continue;

    if (!inHunk) {
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) { cur.oldPath = line.slice(12); cur.status = "renamed"; }
      else if (line.startsWith("rename to ")) { cur.path = line.slice(10); cur.status = "renamed"; }
      else if (line.startsWith("Binary files ")) cur.binary = true;
      else if (line.startsWith("--- ") && line !== "--- /dev/null") cur.oldPath = stripPrefix(line.slice(4));
      else if (line.startsWith("+++ ") && line !== "+++ /dev/null") cur.path = stripPrefix(line.slice(4));
    }

    const h = HUNK.exec(line);
    if (h) {
      cur.hunks.push({
        oldStart: Number(h[1]),
        oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]),
        newLines: h[4] === undefined ? 1 : Number(h[4]),
      });
      inHunk = true;
      continue;
    }
    if (inHunk) {
      if (line.startsWith("+")) cur.added++;
      else if (line.startsWith("-")) cur.removed++;
    }
  }

  for (const f of files) if (f.status === "deleted") f.path = f.oldPath;
  return files;
}

/** True when the line falls inside a hunk on that side of the diff (context lines count). */
export function lineInDiff(file: DiffFile, side: "old" | "new", line: number): boolean {
  return file.hunks.some((h) => {
    const start = side === "new" ? h.newStart : h.oldStart;
    const count = side === "new" ? h.newLines : h.oldLines;
    return count > 0 && line >= start && line < start + count;
  });
}

/** The diff with old and new line numbers in front of each line, so citations can be exact.
    `only` limits it to files whose path contains that text. */
export function annotateDiff(text: string, only?: string): string {
  const out: string[] = [];
  let oldN = 0;
  let newN = 0;
  let show = !only;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      show = !only || !!m?.[2]?.includes(only) || !!m?.[1]?.includes(only);
      inHunk = false;
      if (show) out.push("", `=== ${m?.[2] ?? line}`);
      continue;
    }
    const h = HUNK.exec(line);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[3]);
      inHunk = true;
      if (show) out.push(line);
      continue;
    }
    if (!show || !inHunk) continue;
    const pad = (n: number | "") => String(n).padStart(5);
    if (line.startsWith("+")) out.push(`${pad("")} ${pad(newN++)} ${line}`);
    else if (line.startsWith("-")) out.push(`${pad(oldN++)} ${pad("")} ${line}`);
    else if (line.startsWith("\\")) out.push(`${pad("")} ${pad("")} ${line}`);
    else if (line.startsWith(" ")) out.push(`${pad(oldN++)} ${pad(newN++)} ${line}`);
  }
  return out.join("\n").trim();
}
