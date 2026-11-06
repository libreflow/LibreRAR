import { fileNameOf } from "../lib/format";
import type { CreateFormat } from "../types";
import { FileIcon, LoaderIcon } from "./Icons";

interface CreatePanelProps {
  busy: boolean;
  sources: string[];
  format: CreateFormat;
  encryptionEnabled: boolean;
  password: string;
  passwordConfirm: string;
  passwordError: string | null;
  onCancel: () => void;
  onCreate: () => void;
  onAddFiles: () => void;
  onAddDir: () => void;
  onFormatChange: (format: CreateFormat) => void;
  onToggleEncryption: (enabled: boolean) => void;
  onPasswordChange: (password: string) => void;
  onPasswordConfirmChange: (confirm: string) => void;
}

const CREATE_FORMATS: { value: CreateFormat; label: string }[] = [
  { value: "zip", label: "ZIP · Deflate, multi-cœur" },
  { value: "sevenz", label: "7z · LZMA2, compression maximale" },
  { value: "targz", label: "TAR.GZ · gzip, universel" },
  { value: "tarzst", label: "TAR.ZST · Zstandard, rapide" },
];

export default function CreatePanel({
  busy,
  sources,
  format,
  encryptionEnabled,
  password,
  passwordConfirm,
  passwordError,
  onCancel,
  onCreate,
  onAddFiles,
  onAddDir,
  onFormatChange,
  onToggleEncryption,
  onPasswordChange,
  onPasswordConfirmChange,
}: CreatePanelProps) {
  return (
    <section className="create-panel">
      <h2>Créer une archive</h2>
      <p>
        {sources.length} élément(s) à compresser. Choisissez le format puis
        l'emplacement du fichier.
      </p>
      <ul className="create-list">
        {sources.map((source) => (
          <li key={source} title={source}>
            <FileIcon className="list-icon" /> {fileNameOf(source)}
          </li>
        ))}
      </ul>
      <fieldset className="create-format">
        <legend>Format</legend>
        {CREATE_FORMATS.map(({ value, label }) => (
          <label key={value} className="create-format-option">
            <input
              type="radio"
              name="create-format"
              value={value}
              checked={format === value}
              disabled={busy}
              onChange={() => onFormatChange(value)}
            />
            {label}
          </label>
        ))}
      </fieldset>
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
