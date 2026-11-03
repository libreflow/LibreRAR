import { describe, expect, it } from "vitest";
import { detectFormat } from "./archiveApi";

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
});
