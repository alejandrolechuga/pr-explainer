import { describe, expect, it } from "vitest";
import { highlightLines, languageOf } from "../src/highlight.js";

describe("highlightLines", () => {
  it("picks a language from the file name", () => {
    expect(languageOf("src/a.ts")).toBe("ts");
    expect(languageOf("deploy/Dockerfile")).toBe("dockerfile");
    expect(languageOf("notes.weird")).toBeNull();
  });

  it("keeps one entry per line, with balanced spans, across a multi-line comment", () => {
    const lines = ["/* a", "   b */", "const x = '<b>';"];
    const out = highlightLines(lines, "a.ts");
    expect(out).toHaveLength(3);
    for (const l of out) expect((l.match(/<span/g) ?? []).length).toBe((l.match(/<\/span>/g) ?? []).length);
    expect(out[1]).toContain('class="hljs-comment"');
    expect(out[2]).toContain('<span class="hljs-keyword">const</span>');
    expect(out[2]).toContain("&lt;b&gt;");
    expect(out.join("\n")).not.toContain("<b>");
  });

  it("escapes plain text for unknown files", () => {
    expect(highlightLines(["<script>"], "x.unknown")).toEqual(["&lt;script&gt;"]);
  });
});
