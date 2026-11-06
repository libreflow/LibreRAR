/**
 * Taille de volume saisie librement, en Mio. Retourne `null` si la
 * saisie est invalide (vide, non numérique, nulle ou délirante).
 */
export function parseSplitSizeMB(input: string): number | null {
  const value = Number(input.trim().replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value > 1024 * 1024) return null;
  return value;
}

/** Taille de volume en octets (1 Mio = 1024 × 1024 octets). */
export function splitSizeBytes(mib: number): number {
  return Math.round(mib * 1024 * 1024);
}
