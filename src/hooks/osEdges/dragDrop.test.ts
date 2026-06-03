import { describe, expect, it } from "vitest";
import { fileReferenceToken } from "./dragDrop";

describe("fileReferenceToken", () => {
  it("quotes absolute paths so dropped files with spaces remain one @file token", () => {
    expect(fileReferenceToken('/Users/me/My Project/src/App.tsx')).toBe(
      '@"/Users/me/My Project/src/App.tsx"',
    );
  });

  it("escapes quotes and backslashes inside paths", () => {
    expect(fileReferenceToken('/Users/me/a"b\\c.txt')).toBe(
      '@"/Users/me/a\\"b\\\\c.txt"',
    );
  });
});
