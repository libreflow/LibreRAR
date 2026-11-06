import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearHistory,
  loadHistory,
  pushRecentArchive,
  type RecentArchive,
} from "./history";

function fakeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
    key: () => null,
    length: store.size,
  } as unknown as Storage;
}

describe("loadHistory / pushRecentArchive", () => {
  let storage: Storage;
  beforeEach(() => {
    storage = fakeStorage();
  });

  it("retourne une liste vide sans donnée", () => {
    expect(loadHistory(storage)).toEqual([]);
  });

  it("met l'archive en tête, sans doublon, et borne la longueur", () => {
    pushRecentArchive("/a/une.zip", storage);
    pushRecentArchive("/b/deux.7z", storage);
    pushRecentArchive("/a/une.zip", storage);
    let history = loadHistory(storage);
    expect(history.map((a: RecentArchive) => a.name)).toEqual([
      "une.zip",
      "deux.7z",
    ]);

    for (let i = 0; i < 12; i++) {
      pushRecentArchive(`/archives/fichier${i}.zip`, storage);
    }
    history = loadHistory(storage);
    expect(history.length).toBeLessThanOrEqual(8);
  });

  it("ignore les données corrompues", () => {
    vi.spyOn(storage, "getItem").mockReturnValue('{"pas":"une liste"}');
    expect(loadHistory(storage)).toEqual([]);
  });

  it("clearHistory efface tout", () => {
    pushRecentArchive("/a/une.zip", storage);
    clearHistory(storage);
    expect(loadHistory(storage)).toEqual([]);
  });
});
