import { describe, expect, it } from "vitest";
import { wrappedLines } from "./wrap";

describe("wrappedLines", () => {
  it("keeps short lines on one line", () => {
    expect(wrappedLines("", 10)).toBe(1);
    expect(wrappedLines("abc def", 10)).toBe(1);
    expect(wrappedLines("0123456789", 10)).toBe(1);
  });

  it("moves words that do not fit to the next line", () => {
    expect(wrappedLines("hello world", 8)).toBe(2);
    expect(wrappedLines("aaa bbb ccc ddd", 7)).toBe(2);
    expect(wrappedLines("aaa bbb ccc ddd", 6)).toBe(4);
  });

  it("lets trailing spaces hang", () => {
    expect(wrappedLines("0123456789     ", 10)).toBe(1);
  });

  it("splits words longer than a line", () => {
    expect(wrappedLines("x".repeat(25), 10)).toBe(3);
    expect(wrappedLines("ab " + "x".repeat(20), 10)).toBe(3);
    expect(wrappedLines("x".repeat(20) + " y", 10)).toBe(3);
  });

  it("counts tabs and wide characters", () => {
    expect(wrappedLines("\t\tab", 10)).toBe(1);
    expect(wrappedLines("\t\t\tab", 10)).toBe(2);
    expect(wrappedLines("漢字漢字漢字", 10)).toBe(2);
  });
});
