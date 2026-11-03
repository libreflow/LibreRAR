import type { ArchiveEntry } from "../types";

/**
 * Retourne les entrées dont le chemin correspond à la requête
 * (insensible à la casse, sur n'importe quel segment du chemin).
 */
export function filterEntries(entries: ArchiveEntry[], query: string): ArchiveEntry[] {
  const trimmed = query.trim().toLowerCase();
  if (trimmed === "") return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(trimmed));
}

/**
 * Trie les entrées : dossiers d'abord, puis ordre alphabétique.
 */
export function sortEntries(entries: ArchiveEntry[]): ArchiveEntry[] {
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.path.localeCompare(b.path, "fr");
  });
}

export type SortKey = "name" | "size" | "compressed" | "ratio";

/**
 * Trie les entrées : dossiers d'abord, puis selon la clé demandée
 * (croissante ou décroissante). Le tri par nom utilise localeCompare "fr".
 */
export function sortEntriesBy(
  entries: ArchiveEntry[],
  key: SortKey,
  asc: boolean,
): ArchiveEntry[] {
  const dirFactor = asc ? 1 : -1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let cmp: number;
    switch (key) {
      case "size":
        cmp = a.size - b.size || a.path.localeCompare(b.path, "fr");
        break;
      case "compressed":
        cmp = a.compressedSize - b.compressedSize || a.path.localeCompare(b.path, "fr");
        break;
      case "ratio":
        cmp =
          a.compressedSize / (a.size || 1) - b.compressedSize / (b.size || 1) ||
          a.path.localeCompare(b.path, "fr");
        break;
      case "name":
      default:
        cmp = a.path.localeCompare(b.path, "fr");
        break;
    }
    return cmp * dirFactor;
  });
}

/**
 * Trie les chemins de dossiers parents implicites à partir des chemins d'entrées.
 */
export function implicitDirectories(entries: ArchiveEntry[]): ArchiveEntry[] {
  const seen = new Map<string, ArchiveEntry>();
  for (const entry of entries) {
    if (entry.isDir) {
      if (!seen.has(entry.path)) seen.set(entry.path, entry);
      continue;
    }
    const segments = entry.path.split("/").filter(Boolean);
    for (let i = 1; i < segments.length; i++) {
      const dirPath = `${segments.slice(0, i).join("/")}/`;
      if (!seen.has(dirPath)) {
        seen.set(dirPath, {
          path: dirPath,
          size: 0,
          compressedSize: 0,
          isDir: true,
        });
      }
    }
  }
  return [...seen.values()];
}
