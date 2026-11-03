import { useCallback, useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { ArchiveEntry, Status } from "./types";
import { fileNameOf } from "./lib/format";
import { sortEntries, implicitDirectories } from "./lib/entries";
import {
  createZip,
  detectFormat,
  extractArchive,
  listArchive,
} from "./lib/archiveApi";
import { isTauri } from "./lib/platform";
import DropZone from "./components/DropZone";
import ArchiveView from "./components/ArchiveView";
import CreatePanel from "./components/CreatePanel";

interface OpenArchive {
  path: string;
  name: string;
  entries: ArchiveEntry[];
}

const ARCHIVE_FILTERS = [
  {
    name: "Archives",
    extensions: ["zip", "rar", "7z", "jar"],
  },
];

export default function App() {
  const [archive, setArchive] = useState<OpenArchive | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [creating, setCreating] = useState(false);
  const [sources, setSources] = useState<string[]>([]);

  const openArchive = useCallback(async (path: string) => {
    const name = fileNameOf(path);
    const format = detectFormat(name);
    if (!format) {
      setStatus({
        kind: "error",
        message: `Format non pris en charge : ${name}`,
      });
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      const rawEntries = await listArchive(path);
      const entries = sortEntries(implicitDirectories(rawEntries));
      setArchive({ path, name, entries });
      setStatus({
        kind: "info",
        message: `${entries.filter((e) => !e.isDir).length} fichier(s) — ${name}`,
      });
    } catch (error) {
      setStatus({
        kind: "error",
        message: `Impossible de lire l'archive : ${String(error)}`,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const chooseArchive = useCallback(async () => {
    const path = await open({ multiple: false, filters: ARCHIVE_FILTERS });
    if (typeof path === "string" && path.length > 0) {
      await openArchive(path);
    }
  }, [openArchive]);

  // Glisser-déposer d'une archive sur la fenêtre (Tauri uniquement).
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type === "drop") {
        const path = event.payload.paths[0];
        if (path) void openArchive(path);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [openArchive]);

  const handleExtract = useCallback(
    async (destDir: string, password: string | null, selection: string[]) => {
      if (!archive) return;
      setBusy(true);
      setStatus(null);
      try {
        const result = await extractArchive(
          archive.path,
          destDir,
          password,
          selection.length > 0 ? selection : null,
        );
        setStatus({
          kind: "success",
          message: `${result.files} fichier(s) extrait(s) vers ${destDir}`,
        });
      } catch (error) {
        setStatus({
          kind: "error",
          message: `Échec de l'extraction : ${String(error)}`,
        });
      } finally {
        setBusy(false);
      }
    },
    [archive],
  );

  const handleCreate = useCallback(
    async (dest: string, sources: string[]) => {
      setBusy(true);
      setStatus(null);
      try {
        const result = await createZip(dest, sources);
        setStatus({
          kind: "success",
          message: `${result.files} fichier(s) compressé(s) → ${dest}`,
        });
        setCreating(false);
        await openArchive(dest);
      } catch (error) {
        setStatus({
          kind: "error",
          message: `Échec de la création : ${String(error)}`,
        });
      } finally {
        setBusy(false);
      }
    },
    [openArchive],
  );

  const pickExtractDir = useCallback(
    async (password: string | null, selection: string[]) => {
      const destDir = await open({ directory: true, multiple: false });
      if (typeof destDir === "string" && destDir.length > 0) {
        await handleExtract(destDir, password, selection);
      }
    },
    [handleExtract],
  );

  const pickCreateFiles = useCallback(async () => {
    const picked = await open({
      multiple: true,
      filters: [{ name: "Tous les fichiers", extensions: ["*"] }],
    });
    if (Array.isArray(picked) && picked.length > 0) {
      setSources(picked);
      setCreating(true);
    }
  }, []);

  const pickSavePath = useCallback(
    async (sources: string[]) => {
      const dest = await save({
        filters: [{ name: "Archive ZIP", extensions: ["zip"] }],
      });
      if (typeof dest === "string" && dest.length > 0) {
        await handleCreate(dest, sources);
      }
    },
    [handleCreate],
  );

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand-mark">📚</span>
          <h1>LibreRAR</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => void chooseArchive()} disabled={busy}>
            Ouvrir une archive…
          </button>
          <button
            onClick={() => void pickCreateFiles()}
            disabled={busy}
          >
            Nouvelle archive…
          </button>
          {archive && (
            <button
              className="ghost"
              onClick={() => setArchive(null)}
              disabled={busy}
            >
              Fermer
            </button>
          )}
        </div>
      </header>

      {status && (
        <div className={`status status-${status.kind}`} role="status">
          {status.message}
        </div>
      )}

      <main className="main">
        {creating ? (
          <CreatePanel
            busy={busy}
            sources={sources}
            onCancel={() => setCreating(false)}
            onCreate={() => void pickSavePath(sources)}
          />
        ) : archive ? (
          <ArchiveView
            archiveName={archive.name}
            entries={archive.entries}
            busy={busy}
            onExtract={(password, selection) =>
              void pickExtractDir(password, selection)
            }
          />
        ) : (
          <DropZone busy={busy} onPick={() => void chooseArchive()} />
        )}
      </main>

      <footer className="footer">
        LibreRAR — gestionnaire d'archives libre · RAR (lecture), ZIP, 7z
      </footer>
    </div>
  );
}
