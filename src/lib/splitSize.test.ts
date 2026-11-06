import { describe, expect, it } from "vitest";
import { parseSplitSizeMB, splitSizeBytes } from "./splitSize";

describe("parseSplitSizeMB", () => {
  it("accepte les tailles valides, y compris décimales et virgule française", () => {
    expect(parseSplitSizeMB("100")).toBe(100);
    expect(parseSplitSizeMB("1.5")).toBe(1.5);
    expect(parseSplitSizeMB("2,5")).toBe(2.5);
  });

  it("refuse les saisies invalides", () => {
    expect(parseSplitSizeMB("")).toBeNull();
    expect(parseSplitSizeMB("abc")).toBeNull();
    expect(parseSplitSizeMB("0")).toBeNull();
    expect(parseSplitSizeMB("-3")).toBeNull();
    expect(parseSplitSizeMB("99999999")).toBeNull();
  });
});

describe("splitSizeBytes", () => {
  it("convertit les Mio en octets", () => {
    expect(splitSizeBytes(1)).toBe(1024 * 1024);
    expect(splitSizeBytes(10)).toBe(10 * 1024 * 1024);
  });
});
