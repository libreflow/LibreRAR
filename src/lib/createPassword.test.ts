import { describe, expect, it } from "vitest";
import { createPasswordError, effectiveCreatePassword } from "./createPassword";

describe("createPasswordError", () => {
  it("accepte une saisie désactivée quel que soit le contenu", () => {
    expect(createPasswordError(false, "", "")).toBeNull();
    expect(createPasswordError(false, "abc", "xyz")).toBeNull();
  });

  it("refuse un mot de passe vide ou blanc quand la protection est activée", () => {
    expect(createPasswordError(true, "", "")).toMatch(/Saisissez/);
    expect(createPasswordError(true, "   ", "   ")).toMatch(/Saisissez/);
  });

  it("refuse une confirmation différente", () => {
    expect(createPasswordError(true, "abc", "abd")).toMatch(/correspondent/);
    expect(createPasswordError(true, "abc", "abc")).toBeNull();
  });
});

describe("effectiveCreatePassword", () => {
  it("retourne null sans protection ou si la saisie est invalide", () => {
    expect(effectiveCreatePassword(false, "abc", "abc")).toBeNull();
    expect(effectiveCreatePassword(true, "", "")).toBeNull();
    expect(effectiveCreatePassword(true, "abc", "abd")).toBeNull();
  });

  it("retourne le mot de passe si la saisie est valide", () => {
    expect(effectiveCreatePassword(true, "mot-de-passe", "mot-de-passe")).toBe(
      "mot-de-passe",
    );
  });
});
