import { useEffect, useRef } from "react";
import type { AppSettings, ThemePreference } from "../lib/settings";
import { SettingsIcon, XIcon } from "./Icons";

interface SettingsPanelProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  onClose: () => void;
}

const THEME_OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Système" },
  { value: "light", label: "Clair" },
  { value: "dark", label: "Sombre" },
];

/**
 * Panneau de paramètres en fenêtre modale : focus piégé à l'intérieur,
 * fermeture par Échap ou clic sur l'arrière-plan.
 */
export default function SettingsPanel({
  settings,
  onChange,
  onClose,
}: SettingsPanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button, input, [href]",
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="settings-title">
          <span className="modal-title">
            <SettingsIcon /> Paramètres
          </span>
          <button
            type="button"
            className="status-close"
            onClick={onClose}
            aria-label="Fermer les paramètres"
          >
            <XIcon />
          </button>
        </h2>

        <fieldset className="setting-group">
          <legend>Thème</legend>
          <div className="segmented" role="radiogroup" aria-label="Thème de l'interface">
            {THEME_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === option.value}
                  onChange={() => onChange({ ...settings, theme: option.value })}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="setting-row">
          <label htmlFor="setting-dismiss">
            Masquer automatiquement les messages
          </label>
          <label className="switch">
            <input
              id="setting-dismiss"
              type="checkbox"
              checked={settings.autoDismissStatus}
              onChange={(e) =>
                onChange({ ...settings, autoDismissStatus: e.target.checked })
              }
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>

        <div className="setting-row">
          <label htmlFor="setting-confirm">
            Confirmer avant de fermer une archive
          </label>
          <label className="switch">
            <input
              id="setting-confirm"
              type="checkbox"
              checked={settings.confirmBeforeClose}
              onChange={(e) =>
                onChange({ ...settings, confirmBeforeClose: e.target.checked })
              }
            />
            <span className="switch-track" aria-hidden="true" />
          </label>
        </div>

        <p className="settings-hint">
          Les paramètres sont enregistrés localement sur cet appareil.
        </p>
      </div>
    </div>
  );
}
