import type { AppSettings, ThemePreference } from "../lib/settings";
import { useModalDialog } from "../lib/useModalDialog";
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
  const dialogRef = useModalDialog(onClose);

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
          <div
            className="segmented"
            role="radiogroup"
            aria-label="Thème de l'interface"
          >
            {THEME_OPTIONS.map((option) => (
              <label key={option.value}>
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === option.value}
                  onChange={() =>
                    onChange({ ...settings, theme: option.value })
                  }
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

        <div className="setting-row">
          <label htmlFor="setting-crt">Effets CRT (scanlines)</label>
          <label className="switch">
            <input
              id="setting-crt"
              type="checkbox"
              checked={settings.crtEffects}
              onChange={(e) =>
                onChange({ ...settings, crtEffects: e.target.checked })
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
