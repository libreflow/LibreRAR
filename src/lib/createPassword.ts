/**
 * Validation du mot de passe de création d'archive (chiffrement AES-256).
 * Retourne le message d'erreur à afficher, ou null si la saisie est valide.
 */
export function createPasswordError(
  enabled: boolean,
  password: string,
  confirmation: string,
): string | null {
  if (!enabled) return null;
  if (password.trim().length === 0) {
    return "Saisissez un mot de passe (AES-256) ou décochez la protection.";
  }
  if (password !== confirmation) {
    return "Les deux mots de passe ne correspondent pas.";
  }
  return null;
}

/** Mot de passe effectivement transmis au backend (null = archive en clair). */
export function effectiveCreatePassword(
  enabled: boolean,
  password: string,
  confirmation: string,
): string | null {
  if (!enabled || createPasswordError(enabled, password, confirmation)) {
    return null;
  }
  return password;
}
