import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lineInDiff, parseDiff } from "../src/diff.js";

const files = parseDiff(readFileSync(new URL("./fixtures/sample.patch", import.meta.url), "utf8"));
const get = (p: string) => files.find((f) => f.path === p)!;

describe("parseDiff", () => {
  it("finds every file with its status", () => {
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ["src/cart.ts", "modified"],
      ["src/new.ts", "added"],
      ["old.txt", "deleted"],
      ["b/name.ts", "renamed"],
      ["logo.png", "added"],
    ]);
  });

  it("counts added and removed lines", () => {
    expect(get("src/cart.ts")).toMatchObject({ added: 4, removed: 1 });
    expect(get("src/new.ts")).toMatchObject({ added: 2, removed: 0 });
    expect(get("old.txt")).toMatchObject({ added: 0, removed: 1 });
  });

  it("keeps the old path of a rename and marks binaries", () => {
    expect(get("b/name.ts").oldPath).toBe("a/name.ts");
    expect(get("logo.png").binary).toBe(true);
  });

  it("checks lines against hunk ranges on each side", () => {
    const cart = get("src/cart.ts");
    expect(lineInDiff(cart, "new", 10)).toBe(true);
    expect(lineInDiff(cart, "new", 18)).toBe(true);
    expect(lineInDiff(cart, "new", 19)).toBe(false);
    expect(lineInDiff(cart, "old", 15)).toBe(true);
    expect(lineInDiff(cart, "old", 16)).toBe(false);
    expect(lineInDiff(get("old.txt"), "new", 1)).toBe(false);
  });
});

describe("annotateDiff", () => {
  it("numbers old and new lines and filters by file", async () => {
    const { annotateDiff } = await import("../src/diff.js");
    const text = readFileSync(new URL("./fixtures/sample.patch", import.meta.url), "utf8");
    const out = annotateDiff(text, "cart.ts").split("\n");
    expect(out[0]).toBe("=== src/cart.ts");
    expect(out).toContain("   12       -    sum += i.price;");
    expect(out).toContain("         12 +    sum += i.price * i.qty;");
    expect(out).toContain("   14    17    return sum;");
    expect(out.some((l) => l.includes("new.ts"))).toBe(false);
  });
});
