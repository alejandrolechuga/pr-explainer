import { describe, expect, it } from "vitest";
import { extractIntentRecord, findIssueRefs } from "../src/intent.js";

describe("extractIntentRecord", () => {
  it("takes the section up to the next heading of the same level", () => {
    const body = "Summary\n\n## Intent record\n\n**Goal:** bulk discount\n\n### Detail\nmore\n\n## Testing\nran it";
    expect(extractIntentRecord(body)).toBe("**Goal:** bulk discount\n\n### Detail\nmore");
  });

  it("returns null when absent or empty", () => {
    expect(extractIntentRecord("no record here")).toBeNull();
    expect(extractIntentRecord("## Intent record\n\n## Next")).toBeNull();
  });
});

describe("findIssueRefs", () => {
  it("finds tracker keys and closing GitHub refs", () => {
    expect(findIssueRefs("ABC-334 fix", "Closes #12", "branch abc-1")).toEqual(["ABC-334", "#12"]);
  });
});
