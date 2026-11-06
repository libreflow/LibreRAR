import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveEntry, ArchiveFormat } from "../types";
import { compressionRatio, entryBaseName, formatBytes } from "../lib/format";
import { filterEntries, sortEntriesBy, type SortKey } from "../lib/entries";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FileIcon,
  FolderIcon,
  LoaderIcon,
  SquareCheckIcon,
  SquareIcon,
} from "./Icons";

interface ArchiveViewProps {
  archiveName: string;
  format: ArchiveFormat;
  entries: ArchiveEntry[];
  busy: boolean;
  onExtract: (password: string | null, selection: string[]) => void;
  onTest: (password: string | null) => void;
}

const FORMAT_LABELS: Record<ArchiveFormat, string> = {
  zip: "ZIP",
  rar: "RAR",
  sevenz: "7Z",
};

export default function ArchiveView({
  archiveName,
  format,
  entries,
  busy,
  onExtract,
  onTest,
}: ArchiveViewProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);

  // Raccourci « / » : focus sur le filtre (hors champ de saisie).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/") return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const visible = useMemo(
    () => sortEntriesBy(filterEntries(entries, query), sortKey, sortAsc),
    [entries, query, sortKey, sortAsc],
  );

  const sortBy = (key: SortKey) => {
    if (key === sortKey) {
      setSortAsc((prev) => !prev);
    } else {
      setSortKey(key);
      setSortAsc(true);
    }
  };

  const ariaSort = (key: SortKey) =>
    sortKey !== key ? "none" : sortAsc ? "ascending" : "descending";

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return null;
    return sortAsc ? <ArrowUpIcon /> : <ArrowDownIcon />;
  };

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

  // La sélection inclut les dossiers : le backend extrait alors leur contenu.
  const selection = useMemo(
    () => entries.filter((e) => selected.has(e.path)).map((e) => e.path),
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
        <span className={`format-badge format-${format}`}>
          {FORMAT_LABELS[format]}
        </span>
        <span className="archive-name" title={archiveName}>
          {archiveName}
        </span>
        <input
          ref={searchRef}
          type="search"
          placeholder="Filtrer… (/)"
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
          onClick={() =>
            onExtract(password.length > 0 ? password : null, selection)
          }
        >
          {busy ? (
            <>
              <LoaderIcon className="spin" /> Extraction…
            </>
          ) : selection.length > 0 ? (
            `Extraire la sélection (${selection.length})`
          ) : (
            "Tout extraire…"
          )}
        </button>
        <button
          disabled={busy}
          onClick={() => onTest(password.length > 0 ? password : null)}
          title="Vérifier l'intégrité des entrées (CRC) sans extraction"
        >
          {busy ? (
            <>
              <LoaderIcon className="spin" /> Test…
            </>
          ) : (
            "Tester"
          )}
        </button>
      </div>

      <div
        className="entry-table"
        role="table"
        aria-label={`Contenu de ${archiveName}`}
      >
        <div className="entry-row entry-head" role="row">
          <span role="columnheader">
            <button
              type="button"
              className="checkbox"
              role="checkbox"
              aria-checked={
                visible.length > 0 && visible.every((e) => selected.has(e.path))
              }
              onClick={toggleAllVisible}
              aria-label="Tout sélectionner"
            >
              {visible.length > 0 &&
              visible.every((e) => selected.has(e.path)) ? (
                <SquareCheckIcon />
              ) : (
                <SquareIcon />
              )}
            </button>
          </span>
          <span role="columnheader" aria-sort={ariaSort("name")}>
            <button
              type="button"
              className="th-button"
              onClick={() => sortBy("name")}
            >
              Nom {sortIndicator("name")}
            </button>
          </span>
          <span
            className="cell-num"
            role="columnheader"
            aria-sort={ariaSort("size")}
          >
            <button
              type="button"
              className="th-button"
              onClick={() => sortBy("size")}
            >
              Taille {sortIndicator("size")}
            </button>
          </span>
          <span
            className="cell-num"
            role="columnheader"
            aria-sort={ariaSort("compressed")}
          >
            <button
              type="button"
              className="th-button"
              onClick={() => sortBy("compressed")}
            >
              Compressé {sortIndicator("compressed")}
            </button>
          </span>
          <span
            className="cell-num"
            role="columnheader"
            aria-sort={ariaSort("ratio")}
          >
            <button
              type="button"
              className="th-button"
              onClick={() => sortBy("ratio")}
            >
              Taux {sortIndicator("ratio")}
            </button>
          </span>
        </div>
        {visible.map((entry, index) => (
          <div
            key={entry.path}
            className="entry-row"
            role="row"
            onClick={() => toggle(entry.path)}
            style={{ animationDelay: `${Math.min(index * 14, 280)}ms` }}
          >
            <span role="cell">
              <button
                type="button"
                className="checkbox"
                role="checkbox"
                aria-checked={selected.has(entry.path)}
                aria-label={`Sélectionner ${entryBaseName(entry.path)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(entry.path);
                }}
              >
                {selected.has(entry.path) ? (
                  <SquareCheckIcon />
                ) : (
                  <SquareIcon />
                )}
              </button>
            </span>
            <span className="entry-name" role="cell">
              {entry.isDir ? <FolderIcon /> : <FileIcon />}{" "}
              {entryBaseName(entry.path)}
            </span>
            <span className="cell-num" role="cell">
              {entry.isDir ? "—" : formatBytes(entry.size)}
            </span>
            <span className="cell-num" role="cell">
              {entry.isDir || entry.compressedSize === 0
                ? "—"
                : formatBytes(entry.compressedSize)}
            </span>
            <span className="cell-num" role="cell">
              {entry.isDir
                ? "—"
                : compressionRatio(entry.size, entry.compressedSize)}
            </span>
          </div>
        ))}
        {visible.length === 0 && (
          <div className="entry-empty">
            Aucune entrée ne correspond au filtre.
          </div>
        )}
      </div>

      <div className="archive-summary">
        {totals.files} fichier(s) · {formatBytes(totals.size)} →{" "}
        {/* RAR : tailles compressées non exposées par le backend. */}
        {totals.compressed > 0 ? formatBytes(totals.compressed) : "—"} ·{" "}
        {entries.length} entrée(s)
      </div>
    </section>
  );
}
