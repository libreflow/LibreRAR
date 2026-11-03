import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ArchiveEntry, ArchiveFormat, OperationResult, Status } from "./types";
import { fileNameOf, formatBytes } from "./lib/format";
import { sortEntries, implicitDirectories } from "./lib/entries";
import {
  cancelOperation,
  createZip,
  detectFormat,
  extractArchive,
  listArchive,
  type OperationProgress,
} from "./lib/archiveApi";
import { isTauri } from "./lib/platform";
import { loadSettings, saveSettings, type AppSettings } from "./lib/settings";
import { startChiptune } from "./lib/chiptune";
import DropZone from "./components/DropZone";
import ArchiveView from "./components/ArchiveView";
import CreatePanel from "./components/CreatePanel";
import SettingsPanel from "./components/SettingsPanel";
import BalatroPopup, { pickPraise } from "./components/BalatroPopup";
import {
  CircleCheckIcon,
  CircleXIcon,
  InfoIcon,
  LogoIcon,
  SettingsIcon,
  XIcon,
} from "./components/Icons";

interface OpenArchive {
  path: string;
  name: string;
  format: ArchiveFormat;
  entries: ArchiveEntry[];
}

const ARCHIVE_FILTERS = [
  {
    name: "Archives",
    extensions: ["zip", "rar", "7z", "jar"],
  },
];

const STATUS_ICONS = {
  info: InfoIcon,
  success: CircleCheckIcon,
  error: CircleXIcon,
} as const;

// Les messages d'information/succès disparaissent seuls ; les erreurs
// restent jusqu'à fermeture manuelle.
const STATUS_AUTO_DISMISS_MS = 6000;

export default function App() {
  const [archive, setArchive] = useState<OpenArchive | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [creating, setCreating] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // Archive dont la lecture a échoué (mot de passe probablement requis).
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pendingPassword, setPendingPassword] = useState("");
  // Easter egg : dernier résultat d'opération, affiché par la séquence « JIMBO ».
  const [lastResult, setLastResult] = useState<OperationResult | null>(null);
  const [showBalatro, setShowBalatro] = useState(false);
  const [balatroPraise, setBalatroPraise] = useState("EXCELLENT !");
  // Mode Balatro complet (thème animé), basculé par la séquence « JIMBO ».
  const [balatroMode, setBalatroMode] = useState(false);
  // Opérations longues : progression (barre) et annulation.
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [extractDest, setExtractDest] = useState<string | null>(null);
  const opIdRef = useRef("");

  // Progression émise par le backend, filtrée sur l'opération en cours.
  useEffect(() => {
    const unlisten = listen<OperationProgress>("operation-progress", (event) => {
      if (event.payload.id === opIdRef.current) {
        setProgress(event.payload);
      }
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  /** Démarre une opération : nouvel identifiant d'annulation. */
  const beginOperation = () => {
    const id = crypto.randomUUID();
    opIdRef.current = id;
    setProgress(null);
    return id;
  };

  // Thème : attribut data-theme sur <html> ; absent => suit le système.
  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") {
      delete root.dataset.theme;
    } else {
      root.dataset.theme = settings.theme;
    }
  }, [settings.theme]);

  // Mode Balatro : attribut data-mode sur <html> (palette + fond animé).
  useEffect(() => {
    const root = document.documentElement;
    if (balatroMode) {
      root.dataset.mode = "balatro";
    } else {
      delete root.dataset.mode;
    }
  }, [balatroMode]);

  // Mode Balatro : boucle chiptune originale en fond sonore.
  useEffect(() => {
    if (!balatroMode) return;
    const stopChiptune = startChiptune();
    return stopChiptune;
  }, [balatroMode]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // Réarmement de la confirmation de fermeture après 3 s sans clic.
  useEffect(() => {
    if (!confirmClose) return;
    const timer = window.setTimeout(() => setConfirmClose(false), 3000);
    return () => window.clearTimeout(timer);
  }, [confirmClose]);

  // Fermeture automatique des messages d'information/succès.
  useEffect(() => {
    if (!status || status.kind === "error" || !settings.autoDismissStatus) return;
    const timer = window.setTimeout(() => setStatus(null), STATUS_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [status, settings.autoDismissStatus]);

  const closeArchive = () => {
    if (settings.confirmBeforeClose && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    setArchive(null);
  };

  const openArchive = useCallback(async (path: string, password: string | null = null) => {
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
      const rawEntries = await listArchive(path, password);
      const entries = sortEntries(implicitDirectories(rawEntries));
      setArchive({ path, name, format, entries });
      setPendingPath(null);
      setStatus({
        kind: "info",
        message: `${entries.filter((e) => !e.isDir).length} fichier(s) — ${name}`,
      });
    } catch (error) {
      // Mot de passe probablement requis : proposer une nouvelle tentative.
      setPendingPath(path);
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
      const id = beginOperation();
      setBusy(true);
      setStatus(null);
      setExtractDest(null);
      try {
        const result = await extractArchive(
          id,
          archive.path,
          destDir,
          password,
          selection.length > 0 ? selection : null,
        );
        setStatus({
          kind: "success",
          message: `${result.files} fichier(s) · ${formatBytes(result.bytes)} extraits vers ${destDir}`,
        });
        setLastResult(result);
        setExtractDest(destDir);
      } catch (error) {
        if (String(error).includes("annulée")) {
          setStatus({ kind: "info", message: "Extraction annulée." });
        } else {
          setStatus({
            kind: "error",
            message: `Échec de l'extraction : ${String(error)}`,
          });
        }
      } finally {
        setBusy(false);
        setProgress(null);
      }
    },
    [archive],
  );

  const handleCreate = useCallback(
    async (dest: string, sources: string[]) => {
      const id = beginOperation();
      setBusy(true);
      setStatus(null);
      try {
        const result = await createZip(id, dest, sources);
        setStatus({
          kind: "success",
          message: `${result.files} fichier(s) · ${formatBytes(result.bytes)} compressé(s) → ${dest}`,
        });
        setLastResult(result);
        setCreating(false);
        await openArchive(dest);
      } catch (error) {
        if (String(error).includes("annulée")) {
          setStatus({ kind: "info", message: "Création annulée." });
        } else {
          setStatus({
            kind: "error",
            message: `Échec de la création : ${String(error)}`,
          });
        }
      } finally {
        setBusy(false);
        setProgress(null);
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

  // Ajoute des sources supplémentaires (fichiers ou dossiers) à l'archive
  // en cours de création, sans doublons.
  const addCreateSources = useCallback(async (directory: boolean) => {
    const picked = await open({
      multiple: true,
      directory,
      ...(directory ? {} : { filters: [{ name: "Tous les fichiers", extensions: ["*"] }] }),
    });
    if (Array.isArray(picked) && picked.length > 0) {
      setSources((prev) => [...new Set([...prev, ...picked])]);
      setCreating(true);
    }
  }, []);

  const retryWithPassword = useCallback(() => {
    if (pendingPath) {
      void openArchive(pendingPath, pendingPassword.length > 0 ? pendingPassword : null);
    }
  }, [pendingPath, pendingPassword, openArchive]);

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

  // Raccourcis clavier : Ctrl+O ouvrir, Ctrl+N nouvelle archive.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === "o" && !busy) {
        event.preventDefault();
        void chooseArchive();
      } else if (key === "n" && !busy) {
        event.preventDefault();
        void pickCreateFiles();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [busy, chooseArchive, pickCreateFiles]);

  // Easter egg : la séquence « JIMBO » (hors champ de saisie) déclenche
  // l'affichage du score Balatro de la dernière opération.
  useEffect(() => {
    let buffer = "";
    const onKeyDown = (event: KeyboardEvent) => {
      const tag = document.activeElement?.tagName;
      if (event.key.length !== 1 || tag === "INPUT" || tag === "TEXTAREA") {
        buffer = "";
        return;
      }
      buffer = (buffer + event.key.toLowerCase()).slice(-5);
      if (buffer === "jimbo") {
        buffer = "";
        setBalatroPraise(pickPraise());
        setShowBalatro(true);
        setBalatroMode((prev) => !prev);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="app">
      {busy && (
        <div className="busy-bar" aria-hidden="true">
          {progress && progress.total > 0 ? (
            <div
              className="busy-fill"
              style={{
                width: `${Math.min(100, (progress.done / progress.total) * 100)}%`,
              }}
            />
          ) : (
            <div className="busy-sweep" />
          )}
        </div>
      )}
      {busy && (
        <button
          className="cancel-button"
          onClick={() => void cancelOperation(opIdRef.current)}
          title="Annuler l'opération en cours"
        >
          ANNULER
        </button>
      )}
      <header className="header">
        <div className="brand">
          <LogoIcon className="brand-mark" />
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
              onClick={closeArchive}
              disabled={busy}
            >
              {confirmClose ? "Confirmer ?" : "Fermer"}
            </button>
          )}
          <button
            className="ghost"
            onClick={() => setSettingsOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            aria-label="Paramètres"
          >
            <SettingsIcon className="header-icon" />
          </button>
        </div>
      </header>

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          onChange={setSettings}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {status && (
        <div className={`status status-${status.kind}`} role="status">
          {(() => {
            const StatusIcon = STATUS_ICONS[status.kind];
            return <StatusIcon className="status-icon" />;
          })()}
          <span className="status-message">{status.message}</span>
          {status.kind === "success" && extractDest && (
            <button
              className="status-action"
              onClick={() => void revealItemInDir(extractDest)}
            >
              Ouvrir le dossier
            </button>
          )}
          <button
            className="status-close"
            onClick={() => setStatus(null)}
            aria-label="Fermer le message"
          >
            <XIcon />
          </button>
        </div>
      )}

      {pendingPath && (
        <div className="password-prompt" role="alert">
          <span className="password-prompt-label">
            Lecture de « {fileNameOf(pendingPath)} » impossible — mot de passe requis ?
          </span>
          <input
            type="password"
            placeholder="Mot de passe"
            value={pendingPassword}
            onChange={(e) => setPendingPassword(e.target.value)}
            aria-label="Mot de passe de l'archive"
          />
          <button
            className="primary"
            disabled={busy}
            onClick={retryWithPassword}
          >
            Réessayer
          </button>
          <button className="ghost" onClick={() => setPendingPath(null)}>
            Annuler
          </button>
        </div>
      )}

      <main className="main">
        {creating ? (
          <CreatePanel
            busy={busy}
            sources={sources}
            onCancel={() => setCreating(false)}
            onCreate={() => void pickSavePath(sources)}
            onAddFiles={() => void addCreateSources(false)}
            onAddDir={() => void addCreateSources(true)}
          />
        ) : archive ? (
          <ArchiveView
            archiveName={archive.name}
            format={archive.format}
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
        <span>
          LibreRAR — gestionnaire d'archives libre · RAR (lecture), ZIP, 7z
        </span>
        <span className="footer-shortcuts">
          <kbd>Ctrl+O</kbd> Ouvrir
          <kbd>Ctrl+N</kbd> Nouvelle
          <kbd>/</kbd> Filtrer
        </span>
      </footer>

      {showBalatro && (
        <BalatroPopup
          praise={balatroPraise}
          caption={
            balatroMode
              ? "MODE BALATRO ACTIF — RETAPEZ JIMBO POUR SORTIR"
              : "MODE BALATRO DÉSACTIVÉ"
          }
          chips={lastResult ? formatBytes(lastResult.bytes) : "LIBRE"}
          mult={lastResult ? `${lastResult.files}` : "RAR"}
          onDone={() => setShowBalatro(false)}
        />
      )}
    </div>
  );
}
