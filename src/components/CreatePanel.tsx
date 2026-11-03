import { fileNameOf } from "../lib/format";
import { FileIcon, LoaderIcon } from "./Icons";

interface CreatePanelProps {
  busy: boolean;
  sources: string[];
  onCancel: () => void;
  onCreate: () => void;
  onAddFiles: () => void;
  onAddDir: () => void;
}

export default function CreatePanel({
  busy,
  sources,
  onCancel,
  onCreate,
  onAddFiles,
  onAddDir,
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
        <button className="primary" onClick={onCreate} disabled={busy || sources.length === 0}>
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
