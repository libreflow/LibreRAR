import { describe, expect, it } from "vitest";
import { asAppError, detectFormat } from "./archiveApi";

describe("detectFormat", () => {
  it("détecte les formats par extension", () => {
    expect(detectFormat("archive.rar")).toBe("rar");
    expect(detectFormat("ARCHIVE.ZIP")).toBe("zip");
    expect(detectFormat("backup.7z")).toBe("sevenz");
    expect(detectFormat("app.jar")).toBe("zip");
  });

  it("retourne null pour les formats inconnus", () => {
    expect(detectFormat("photo.png")).toBeNull();
    expect(detectFormat("archive.rar.exe")).toBeNull();
  });

  it("détecte le format derrière un suffixe de volume (.001…)", () => {
    expect(detectFormat("vacances.zip.001")).toBe("zip");
    expect(detectFormat("vacances.7z.014")).toBe("sevenz");
    expect(detectFormat("vacances.rar.002")).toBe("rar");
  });
});

describe("asAppError", () => {
  it("conserve les erreurs structurées du backend", () => {
    expect(
      asAppError({ kind: "cancelled", message: "Opération annulée." }),
    ).toEqual({
      kind: "cancelled",
      message: "Opération annulée.",
    });
    expect(
      asAppError({ kind: "passwordRequired", message: "Mot de passe requis." }),
    ).toEqual({
      kind: "passwordRequired",
      message: "Mot de passe requis.",
    });
  });

  it("normalise toute erreur inconnue en échec générique", () => {
    expect(asAppError("Fichier introuvable")).toEqual({
      kind: "failed",
      message: "Fichier introuvable",
    });
    expect(asAppError({ kind: "autre", message: "x" }).kind).toBe("failed");
    expect(asAppError(null).kind).toBe("failed");
  });
});
