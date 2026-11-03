import { describe, expect, it } from "vitest";
import { filterEntries, implicitDirectories, sortEntries } from "./entries";
import type { ArchiveEntry } from "../types";

const file = (path: string, size = 10): ArchiveEntry => ({
  path,
  size,
  compressedSize: Math.round(size / 2),
  isDir: false,
});

const dir = (path: string): ArchiveEntry => ({
  path,
  size: 0,
  compressedSize: 0,
  isDir: true,
});

describe("filterEntries", () => {
  const entries = [dir("docs/"), file("docs/readme.md"), file("image.png")];

  it("retourne tout sans requête", () => {
    expect(filterEntries(entries, "  ")).toEqual(entries);
  });

  it("filtre par sous-chaîne insensible à la casse", () => {
    const result = filterEntries(entries, "README");
    expect(result).toHaveLength(1);
    expect(result[0]?.path).toBe("docs/readme.md");
  });
});

describe("sortEntries", () => {
  it("place les dossiers en premier puis trie alphabétiquement", () => {
    const sorted = sortEntries([file("b.txt"), dir("zz/"), file("a.txt")]);
    expect(sorted.map((e) => e.path)).toEqual(["zz/", "a.txt", "b.txt"]);
  });

  it("ne modifie pas le tableau d'entrée", () => {
    const input = [file("b.txt"), file("a.txt")];
    sortEntries(input);
    expect(input.map((e) => e.path)).toEqual(["b.txt", "a.txt"]);
  });
});

describe("implicitDirectories", () => {
  it("déduit les dossiers parents manquants", () => {
    const result = implicitDirectories([file("docs/img/logo.png")]);
    const paths = result.map((e) => e.path);
    expect(paths).toContain("docs/");
    expect(paths).toContain("docs/img/");
    expect(result.every((e) => e.isDir)).toBe(true);
  });

  it("ne duplique pas les dossiers explicites", () => {
    const result = implicitDirectories([dir("docs/"), file("docs/a.txt")]);
    expect(result).toHaveLength(1);
  });
});
