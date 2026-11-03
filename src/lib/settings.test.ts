import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "./settings";

// Stockage en mémoire pour isoler les tests de l'environnement.
class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

describe("settings", () => {
  let storage: Storage;

  afterEach(() => {
    storage.clear();
  });

  it("retourne les valeurs par défaut sur stockage vide", () => {
    storage = new MemoryStorage();
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("retombe sur les défauts si le JSON est corrompu", () => {
    storage = new MemoryStorage();
    storage.setItem("librerar.settings", "{pas du json");
    expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
  });

  it("écarte les valeurs invalides", () => {
    storage = new MemoryStorage();
    saveSettings(
      {
        theme: "violet",
        autoDismissStatus: "oui",
        confirmBeforeClose: true,
      } as unknown as ReturnType<typeof loadSettings>,
      storage,
    );
    const loaded = loadSettings(storage);
    expect(loaded.theme).toBe("system");
    expect(loaded.autoDismissStatus).toBe(true);
    expect(loaded.confirmBeforeClose).toBe(true);
  });

  it("fait un aller-retour complet", () => {
    storage = new MemoryStorage();
    const settings = { theme: "dark" as const, autoDismissStatus: false, confirmBeforeClose: true };
    saveSettings(settings, storage);
    expect(loadSettings(storage)).toEqual(settings);
  });
});
