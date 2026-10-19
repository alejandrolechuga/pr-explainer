// Syntax colours for code on the page, worked out when the page is built (no script on the page).
import hljs from "highlight.js";

const BY_NAME: Record<string, string> = { dockerfile: "dockerfile", makefile: "makefile", gemfile: "ruby", rakefile: "ruby" };

/** the highlight.js language for a file path, or null for plain text */
export function languageOf(path: string): string | null {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  if (BY_NAME[name]) return BY_NAME[name]!;
  const ext = name.includes(".") ? name.split(".").pop()! : "";
  return ext && hljs.getLanguage(ext) ? ext : null;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Highlight lines as one piece of code (so a string or comment that runs over lines stays coloured),
    then cut it back into lines, closing and reopening colour spans at each line break.
    Returns one HTML string per input line. */
export function highlightLines(lines: string[], path: string): string[] {
  const lang = languageOf(path);
  if (!lang) return lines.map(esc);
  let html: string;
  try { html = hljs.highlight(lines.join("\n"), { language: lang, ignoreIllegals: true }).value; } catch { return lines.map(esc); }
  const out: string[] = [];
  const open: string[] = [];
  let cur = "";
  for (const tok of html.match(/<span[^>]*>|<\/span>|\n|[^<\n]+/g) ?? []) {
    if (tok === "\n") {
      out.push(cur + "</span>".repeat(open.length));
      cur = open.join("");
    } else if (tok.startsWith("<span")) { open.push(tok); cur += tok; }
    else if (tok === "</span>") { open.pop(); cur += tok; }
    else cur += tok;
  }
  out.push(cur + "</span>".repeat(open.length));
  return out.length === lines.length ? out : lines.map(esc);
}
