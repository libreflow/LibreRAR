const HISTORY_KEY = "librerar.history.v1";
const HISTORY_MAX = 8;

export interface RecentArchive {
  path: string;
  name: string;
}

/**
 * Historique des archives récemment ouvertes (stockage local) ; toute
 * donnée invalide ou corrompue retombe sur une liste vide.
 */
export function loadHistory(
  storage: Storage = window.localStorage,
): RecentArchive[] {
  try {
    const raw = storage.getItem(HISTORY_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is RecentArchive =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as RecentArchive).path === "string" &&
          typeof (item as RecentArchive).name === "string",
      )
      .slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

/** Enregistre une archive ouverte en tête d'historique (sans doublon). */
export function pushRecentArchive(
  path: string,
  storage: Storage = window.localStorage,
): RecentArchive[] {
  const name = path.split(/[\\/]/).pop() ?? path;
  const next = [
    { path, name },
    ...loadHistory(storage).filter((a) => a.path !== path),
  ].slice(0, HISTORY_MAX);
  try {
    storage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // Historique indisponible (stockage plein/bloqué) : non bloquant.
  }
  return next;
}

/** Efface l'historique. */
export function clearHistory(storage: Storage = window.localStorage): void {
  try {
    storage.removeItem(HISTORY_KEY);
  } catch {
    // Ignoré : non bloquant.
  }
}
