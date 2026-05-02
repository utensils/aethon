import { describe, expect, it } from "vitest";
import { shellQuote, shellQuoteAll } from "./shellQuote";

describe("shellQuote", () => {
  it("returns '' for the empty string", () => {
    expect(shellQuote("")).toBe("''");
  });

  it("leaves safe ASCII paths un-quoted", () => {
    expect(shellQuote("/usr/local/bin/zsh")).toBe("/usr/local/bin/zsh");
    expect(shellQuote("README.md")).toBe("README.md");
    expect(shellQuote("./foo-bar_42")).toBe("./foo-bar_42");
    expect(shellQuote("user@host:/path")).toBe("user@host:/path");
  });

  it("wraps paths that contain spaces", () => {
    expect(shellQuote("/Users/me/My Films/wow.mp4")).toBe(
      "'/Users/me/My Films/wow.mp4'",
    );
  });

  it("escapes embedded single quotes via close-quote/escape/re-open trick", () => {
    expect(shellQuote("it's a test")).toBe("'it'\\''s a test'");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });

  it("wraps paths that contain shell metacharacters", () => {
    // dollar sign, backtick, semicolon, ampersand, pipe — all unsafe
    expect(shellQuote("foo $bar")).toBe("'foo $bar'");
    expect(shellQuote("rm -rf;")).toBe("'rm -rf;'");
    expect(shellQuote("a|b&c")).toBe("'a|b&c'");
    expect(shellQuote("`cmd`")).toBe("'`cmd`'");
  });

  it("wraps paths with double-quotes and backslashes", () => {
    expect(shellQuote('she said "hi"')).toBe(`'she said "hi"'`);
    expect(shellQuote("c:\\Users")).toBe(`'c:\\Users'`);
  });

  it("survives unicode without mangling", () => {
    expect(shellQuote("résumé.pdf")).toBe(`'résumé.pdf'`);
    expect(shellQuote("中文路径.txt")).toBe(`'中文路径.txt'`);
  });

  it("shellQuoteAll joins quoted args with single spaces", () => {
    expect(shellQuoteAll(["a", "b c", "d"])).toBe("a 'b c' d");
    expect(shellQuoteAll([])).toBe("");
    expect(shellQuoteAll([""])).toBe("''");
  });
});
