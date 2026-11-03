export type ThemePreference = "system" | "light" | "dark";

export interface AppSettings {
  theme: ThemePreference;
  /** Masquer automatiquement les messages d'information/succès. */
  autoDismissStatus: boolean;
  /** Demander une confirmation avant de fermer une archive ouverte. */
  confirmBeforeClose: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: "system",
  autoDismissStatus: true,
  confirmBeforeClose: false,
};

const STORAGE_KEY = "librerar.settings";

const THEME_VALUES: ThemePreference[] = ["system", "light", "dark"];

function normalize(partial: Partial<AppSettings>): AppSettings {
  return {
    theme: THEME_VALUES.includes(partial.theme as ThemePreference)
      ? (partial.theme as ThemePreference)
      : DEFAULT_SETTINGS.theme,
    autoDismissStatus:
      typeof partial.autoDismissStatus === "boolean"
        ? partial.autoDismissStatus
        : DEFAULT_SETTINGS.autoDismissStatus,
    confirmBeforeClose:
      typeof partial.confirmBeforeClose === "boolean"
        ? partial.confirmBeforeClose
        : DEFAULT_SETTINGS.confirmBeforeClose,
  };
}

/**
 * Charge les paramètres depuis le stockage local ; toute valeur invalide
 * ou corrompue retombe sur les valeurs par défaut.
 */
export function loadSettings(storage: Storage = window.localStorage): AppSettings {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return normalize(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(
  settings: AppSettings,
  storage: Storage = window.localStorage,
): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}
