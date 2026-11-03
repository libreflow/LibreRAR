import { describe, expect, it } from "vitest";
import { compressionRatio, entryBaseName, fileNameOf, formatBytes } from "./format";

describe("formatBytes", () => {
  it("formate les petites tailles", () => {
    expect(formatBytes(0)).toBe("0 o");
    expect(formatBytes(512)).toBe("512 o");
  });

  it("formate les unités supérieures", () => {
    expect(formatBytes(1024)).toBe("1.00 Ko");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.00 Mo");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.00 Go");
  });

  it("gère les valeurs invalides", () => {
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

describe("compressionRatio", () => {
  it("calcule le taux", () => {
    expect(compressionRatio(1000, 250)).toBe("25 %");
  });

  it("retourne un tiret pour les tailles nulles", () => {
    expect(compressionRatio(0, 100)).toBe("—");
    expect(compressionRatio(100, 0)).toBe("—");
  });
});

describe("fileNameOf", () => {
  it("extrait le nom depuis un chemin", () => {
    expect(fileNameOf("C:\\Archives\\test.rar")).toBe("test.rar");
    expect(fileNameOf("/home/user/archives.zip")).toBe("archives.zip");
  });
});

describe("entryBaseName", () => {
  it("ignore les slashs finaux des dossiers", () => {
    expect(entryBaseName("docs/")).toBe("docs");
    expect(entryBaseName("docs/readme.md")).toBe("readme.md");
  });
});
