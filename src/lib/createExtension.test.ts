import { describe, expect, it } from "vitest";
import { ensureCreateExtension } from "./createExtension";

describe("ensureCreateExtension", () => {
  it("laisse intact un nom déjà conforme au format", () => {
    expect(ensureCreateExtension("b.tar.gz", "targz")).toBe("b.tar.gz");
    expect(ensureCreateExtension("c.zip", "zip")).toBe("c.zip");
    expect(ensureCreateExtension("d.7z", "sevenz")).toBe("d.7z");
    expect(ensureCreateExtension("e.tar.zst", "tarzst")).toBe("e.tar.zst");
  });

  it("remplace une mauvaise extension ou l'ajoute si absente", () => {
    // « x.gz » seul serait indétectable à l'ouverture.
    expect(ensureCreateExtension("x.gz", "targz")).toBe("x.tar.gz");
    expect(ensureCreateExtension("vacances", "targz")).toBe("vacances.tar.gz");
    expect(ensureCreateExtension("x.tar", "targz")).toBe("x.tar.gz");
    expect(ensureCreateExtension("x.7z", "zip")).toBe("x.zip");
    expect(ensureCreateExtension("x.tgz", "tarzst")).toBe("x.tar.zst");
  });

  it("préserve les points qui ne sont pas des extensions d'archive", () => {
    expect(ensureCreateExtension("backup.v2.zip", "zip")).toBe("backup.v2.zip");
    expect(ensureCreateExtension("sauvegarde 2026", "targz")).toBe(
      "sauvegarde 2026.tar.gz",
    );
  });
});
