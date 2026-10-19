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

export interface Row {
  kind: "+" | "-" | " ";
  old?: number;
  new?: number;
  text: string;
  hunk: number;
}

/** every line of every hunk, per file (new path), with old and new numbers */
export function diffRows(text: string): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  let rows: Row[] | null = null;
  let oldN = 0;
  let newN = 0;
  let hunk = -1;
  let inHunk = false;
  let deleted = false;
  let oldPath = "";
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      oldPath = m?.[1] ?? "";
      rows = [];
      out.set(m?.[2] ?? oldPath, rows);
      inHunk = false;
      deleted = false;
      continue;
    }
    if (!rows) continue;
    if (!inHunk && line.startsWith("deleted file mode")) deleted = true;
    if (!inHunk && line.startsWith("rename to ")) { const r = rows; for (const [k, v] of out) if (v === r) out.delete(k); out.set(line.slice(10), r); }
    const h = HUNK.exec(line);
    if (h) {
      oldN = Number(h[1]);
      newN = Number(h[3]);
      hunk++;
      inHunk = true;
      if (deleted && oldPath) { const r = rows; for (const [k, v] of out) if (v === r) out.delete(k); out.set(oldPath, r); }
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) rows.push({ kind: "+", new: newN++, text: line.slice(1), hunk });
    else if (line.startsWith("-")) rows.push({ kind: "-", old: oldN++, text: line.slice(1), hunk });
    else if (line.startsWith(" ")) rows.push({ kind: " ", old: oldN++, new: newN++, text: line.slice(1), hunk });
  }
  return out;
}

/** The diff lines a citation points at, with a little context, inside one hunk.
    Long ranges keep their first `max` lines and say how many were left out. */
export function excerpt(rows: Row[] | undefined, side: "new" | "old", line: number, end = line, context = 2, max = 30): { rows: Row[]; more: number } {
  if (!rows) return { rows: [], more: 0 };
  const num = (r: Row) => (side === "new" ? r.new : r.old);
  const hits = rows.map((r, i) => [r, i] as const).filter(([r]) => { const n = num(r); return n !== undefined && n >= line && n <= end; });
  if (!hits.length) return { rows: [], more: 0 };
  const hunk = hits[0]![0].hunk;
  let a = hits[0]![1];
  let b = hits.filter(([r]) => r.hunk === hunk).at(-1)![1];
  // removed lines right before the first cited new line belong to the change, not the context
  if (side === "new") while (a > 0 && rows[a - 1]!.hunk === hunk && rows[a - 1]!.kind === "-") a--;
  for (let k = 0; k < context && a > 0 && rows[a - 1]!.hunk === hunk; k++) a--;
  for (let k = 0; k < context && b < rows.length - 1 && rows[b + 1]!.hunk === hunk; k++) b++;
  const all = rows.slice(a, b + 1);
  return all.length > max ? { rows: all.slice(0, max), more: all.length - max } : { rows: all, more: 0 };
}
