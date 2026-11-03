import { fileNameOf } from "../lib/format";

interface CreatePanelProps {
  busy: boolean;
  sources: string[];
  onCancel: () => void;
  onCreate: () => void;
}

export default function CreatePanel({
  busy,
  sources,
  onCancel,
  onCreate,
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
            📄 {fileNameOf(source)}
          </li>
        ))}
      </ul>
      <div className="create-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Annuler
        </button>
        <button className="primary" onClick={onCreate} disabled={busy || sources.length === 0}>
          {busy ? "Compression…" : "Choisir l'emplacement…"}
        </button>
      </div>
    </section>
  );
}
