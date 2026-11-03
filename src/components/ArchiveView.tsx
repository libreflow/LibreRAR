import { useMemo, useState } from "react";
import type { ArchiveEntry } from "../types";
import { compressionRatio, entryBaseName, formatBytes } from "../lib/format";
import { filterEntries } from "../lib/entries";

interface ArchiveViewProps {
  archiveName: string;
  entries: ArchiveEntry[];
  busy: boolean;
  onExtract: (password: string | null, selection: string[]) => void;
}

export default function ArchiveView({
  archiveName,
  entries,
  busy,
  onExtract,
}: ArchiveViewProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");

  const visible = useMemo(() => filterEntries(entries, query), [entries, query]);

  const toggle = (path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelected((prev) => {
      const allSelected = visible.every((e) => prev.has(e.path));
      const next = new Set(prev);
      for (const entry of visible) {
        if (allSelected) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }
      }
      return next;
    });
  };

  const selection = useMemo(
    () => entries.filter((e) => selected.has(e.path) && !e.isDir).map((e) => e.path),
    [entries, selected],
  );

  const totals = useMemo(() => {
    let size = 0;
    let compressed = 0;
    let files = 0;
    for (const entry of entries) {
      if (entry.isDir) continue;
      files += 1;
      size += entry.size;
      compressed += entry.compressedSize;
    }
    return { files, size, compressed };
  }, [entries]);

  return (
    <section className="archive-view">
      <div className="archive-toolbar">
        <span className="archive-name" title={archiveName}>
          {archiveName}
        </span>
        <input
          type="search"
          placeholder="Filtrer…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filtrer les entrées"
        />
        <input
          type="password"
          placeholder="Mot de passe (optionnel)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Mot de passe de l'archive"
        />
        <button
          className="primary"
          disabled={busy}
          onClick={() => onExtract(password.length > 0 ? password : null, selection)}
        >
          {busy
            ? "…"
            : selection.length > 0
              ? `Extraire la sélection (${selection.length})`
              : "Tout extraire…"}
        </button>
      </div>

      <div className="entry-table" role="table">
        <div className="entry-row entry-head" role="row">
          <button
            className="checkbox"
            onClick={toggleAllVisible}
            aria-label="Tout sélectionner"
          >
            {visible.every((e) => selected.has(e.path)) && visible.length > 0
              ? "☑"
              : "☐"}
          </button>
          <span>Nom</span>
          <span>Taille</span>
          <span>Compressé</span>
          <span>Taux</span>
        </div>
        {visible.map((entry) => (
          <div
            key={entry.path}
            className="entry-row"
            role="row"
            onClick={() => toggle(entry.path)}
          >
            <span className="checkbox">
              {selected.has(entry.path) ? "☑" : "☐"}
            </span>
            <span className="entry-name">
              {entry.isDir ? "📁" : "📄"} {entryBaseName(entry.path)}
            </span>
            <span>{entry.isDir ? "—" : formatBytes(entry.size)}</span>
            <span>{entry.isDir ? "—" : formatBytes(entry.compressedSize)}</span>
            <span>
              {entry.isDir ? "—" : compressionRatio(entry.size, entry.compressedSize)}
            </span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="entry-empty">Aucune entrée ne correspond au filtre.</div>
        )}
      </div>

      <div className="archive-summary">
        {totals.files} fichier(s) · {formatBytes(totals.size)} →{" "}
        {formatBytes(totals.compressed)} · {entries.length} entrée(s)
      </div>
    </section>
  );
}
