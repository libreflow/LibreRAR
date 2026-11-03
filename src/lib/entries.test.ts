import { describe, expect, it } from "vitest";
import { filterEntries, implicitDirectories, sortEntries, sortEntriesBy } from "./entries";
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

describe("sortEntriesBy", () => {
  it("trie par taille croissante puis décroissante, dossiers d'abord", () => {
    const entries = [file("b.txt", 30), dir("zz/"), file("a.txt", 10), file("c.txt", 20)];
    const asc = sortEntriesBy(entries, "size", true);
    expect(asc.map((e) => e.path)).toEqual(["zz/", "a.txt", "c.txt", "b.txt"]);
    const desc = sortEntriesBy(entries, "size", false);
    expect(desc.map((e) => e.path)).toEqual(["zz/", "b.txt", "c.txt", "a.txt"]);
  });

  it("trie par taille compressée", () => {
    const a = { path: "a.zip", size: 100, compressedSize: 90, isDir: false };
    const b = { path: "b.zip", size: 100, compressedSize: 10, isDir: false };
    const result = sortEntriesBy([a, b], "compressed", true);
    expect(result.map((e) => e.path)).toEqual(["b.zip", "a.zip"]);
  });

  it("trie par taux de compression", () => {
    const a = { path: "a.bin", size: 100, compressedSize: 50, isDir: false };
    const b = { path: "b.bin", size: 100, compressedSize: 10, isDir: false };
    const result = sortEntriesBy([a, b], "ratio", true);
    expect(result.map((e) => e.path)).toEqual(["b.bin", "a.bin"]);
  });

  it("départage les égalités par nom", () => {
    const entries = [file("b.txt", 10), file("a.txt", 10)];
    const result = sortEntriesBy(entries, "size", true);
    expect(result.map((e) => e.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("ne modifie pas le tableau d'entrée", () => {
    const input = [file("b.txt", 2), file("a.txt", 1)];
    sortEntriesBy(input, "size", true);
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
