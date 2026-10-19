// Finds the "## Intent record" section in a PR body.

export const INTENT_HEADING = "Intent record";

export function extractIntentRecord(body: string): string | null {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,3}\s+intent record\b/i.test(l.trim()));
  if (start < 0) return null;
  const level = /^(#+)/.exec(lines[start]!.trim())?.[1]?.length ?? 2;
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^(#+)\s/.exec(l.trim());
    if (m && m[1]!.length <= level) break;
    out.push(l);
  }
  const text = out.join("\n").trim();
  return text.length ? text : null;
}

/** Tracker issue keys (ABC-123, as Linear and Jira use) and GitHub refs (#12) mentioned in text. */
export function findIssueRefs(...texts: string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/\b([A-Z][A-Z0-9]{1,9}-\d+)\b/g)) found.add(m[1]!);
    for (const m of t.matchAll(/(?:closes|fixes|resolves|refs?)\s+#(\d+)/gi)) found.add(`#${m[1]}`);
  }
  return [...found];
}
