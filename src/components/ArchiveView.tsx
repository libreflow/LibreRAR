import { useEffect, useMemo, useRef, useState } from "react";
import type { ArchiveEntry, ArchiveFormat } from "../types";
import { compressionRatio, entryBaseName, formatBytes } from "../lib/format";
import { filterEntries, sortEntriesBy, type SortKey } from "../lib/entries";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
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
  onSplit: () => void;
  onChecksum: () => void;
  onPreview: (entryPath: string, password: string | null) => void;
}

const FORMAT_LABELS: Record<ArchiveFormat, string> = {
  zip: "ZIP",
  rar: "RAR",
  sevenz: "7Z",
  tar: "TAR",
  targz: "TAR.GZ",
  tarxz: "TAR.XZ",
  tarzst: "TAR.ZST",
};

export default function ArchiveView({
  archiveName,
  format,
  entries,
  busy,
  onExtract,
  onTest,
  onSplit,
  onChecksum,
  onPreview,
}: ArchiveViewProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const tableRef = useRef<HTMLDivElement>(null);

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

  // Champ mot de passe masqué si le backend peut prouver qu'aucune
  // entrée n'est chiffrée (ZIP, TAR). RAR/7z : caractère inconnu → affiché.
  const maybeEncrypted = useMemo(
    () => entries.some((e) => e.encrypted !== false),
    [entries],
  );

  // Navigation clavier : ↑/↓ déplacent le focus entre les lignes du
  // tableau (chaque ligne est atteignable par sa case à cocher).
  const navigateRows = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      tableRef.current?.querySelectorAll<HTMLElement>(
        ".entry-row:not(.entry-head) .checkbox",
      ) ?? [],
    );
    if (rows.length === 0) return;
    event.preventDefault();
    const index = rows.findIndex(
      (row) =>
        row.contains(document.activeElement) || row === document.activeElement,
    );
    const next =
      index === -1
        ? 0
        : event.key === "ArrowDown"
          ? Math.min(index + 1, rows.length - 1)
          : Math.max(index - 1, 0);
    rows[next]?.focus();
  };

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
        {(maybeEncrypted || password.length > 0) && (
          <input
            type="password"
            placeholder="Mot de passe"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-label="Mot de passe de l'archive"
          />
        )}
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
        <button
          disabled={busy}
          onClick={onSplit}
          title="Découper l'archive en volumes"
        >
          Découper…
        </button>
        <button
          disabled={busy}
          onClick={onChecksum}
          title="Calculer la somme SHA-256 de l'archive"
        >
          SHA-256
        </button>
      </div>

      <div
        className="entry-table"
        role="table"
        aria-label={`Contenu de ${archiveName}`}
        aria-rowcount={entries.length + 1}
        aria-colcount={6}
        ref={tableRef}
        onKeyDown={navigateRows}
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
          <span role="columnheader" aria-label="Aperçu" />
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
            <span className="entry-name" role="cell" title={entry.path}>
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
            <span role="cell" className="cell-preview">
              {!entry.isDir && (
                <button
                  type="button"
                  className="ghost preview-button"
                  disabled={busy}
                  aria-label={`Aperçu de ${entryBaseName(entry.path)}`}
                  title="Aperçu (texte/images)"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPreview(
                      entry.path,
                      password.length > 0 ? password : null,
                    );
                  }}
                >
                  <EyeIcon />
                </button>
              )}
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
