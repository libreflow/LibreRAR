import { fileNameOf } from "../lib/format";
import { FileIcon, LoaderIcon } from "./Icons";

interface CreatePanelProps {
  busy: boolean;
  sources: string[];
  encryptionEnabled: boolean;
  password: string;
  passwordConfirm: string;
  passwordError: string | null;
  onCancel: () => void;
  onCreate: () => void;
  onAddFiles: () => void;
  onAddDir: () => void;
  onToggleEncryption: (enabled: boolean) => void;
  onPasswordChange: (password: string) => void;
  onPasswordConfirmChange: (confirm: string) => void;
}

export default function CreatePanel({
  busy,
  sources,
  encryptionEnabled,
  password,
  passwordConfirm,
  passwordError,
  onCancel,
  onCreate,
  onAddFiles,
  onAddDir,
  onToggleEncryption,
  onPasswordChange,
  onPasswordConfirmChange,
}: CreatePanelProps) {
  return (
    <section className="create-panel">
      <h2>Créer une archive ZIP</h2>
      <p>
        {sources.length} élément(s) à compresser. Choisissez l'emplacement du
        fichier .zip.
      </p>
      <ul className="create-list">
        {sources.map((source) => (
          <li key={source} title={source}>
            <FileIcon className="list-icon" /> {fileNameOf(source)}
          </li>
        ))}
      </ul>
      <div className="create-encryption">
        <label className="create-encryption-toggle">
          <input
            type="checkbox"
            checked={encryptionEnabled}
            disabled={busy}
            onChange={(e) => onToggleEncryption(e.target.checked)}
          />
          Protéger par un mot de passe (AES-256)
        </label>
        {encryptionEnabled && (
          <div className="create-password-fields">
            <input
              type="password"
              placeholder="Mot de passe"
              value={password}
              disabled={busy}
              autoComplete="new-password"
              aria-label="Mot de passe de l'archive"
              onChange={(e) => onPasswordChange(e.target.value)}
            />
            <input
              type="password"
              placeholder="Confirmation"
              value={passwordConfirm}
              disabled={busy}
              autoComplete="new-password"
              aria-label="Confirmation du mot de passe"
              onChange={(e) => onPasswordConfirmChange(e.target.value)}
            />
          </div>
        )}
        {encryptionEnabled && passwordError && (
          <p className="create-password-error" role="alert">
            {passwordError}
          </p>
        )}
      </div>
      <div className="create-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Annuler
        </button>
        <button onClick={onAddFiles} disabled={busy}>
          Ajouter des fichiers…
        </button>
        <button onClick={onAddDir} disabled={busy}>
          Ajouter un dossier…
        </button>
        <button
          className="primary"
          onClick={onCreate}
          disabled={busy || sources.length === 0 || !!passwordError}
        >
          {busy ? (
            <>
              <LoaderIcon className="spin" /> Compression…
            </>
          ) : (
            "Choisir l'emplacement…"
          )}
        </button>
      </div>
    </section>
  );
}
