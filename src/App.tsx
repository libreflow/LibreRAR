import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type {
  ArchiveEntry,
  ArchiveFormat,
  CreateFormat,
  OperationResult,
  Status,
} from "./types";
import type { RecentArchive } from "./lib/history";
import { fileNameOf, formatBytes, formatDuration } from "./lib/format";
import { sortEntries, implicitDirectories } from "./lib/entries";
import {
  asAppError,
  cancelOperation,
  createSevenz,
  createTar,
  createZip,
  detectFormat,
  extractArchive,
  listArchive,
  splitArchive,
  testArchive,
  previewEntry,
  checksumArchive,
  exportChecksum,
  type OperationProgress,
} from "./lib/archiveApi";
import { isTauri } from "./lib/platform";
import { clearHistory, loadHistory, pushRecentArchive } from "./lib/history";
import {
  createPasswordError,
  effectiveCreatePassword,
} from "./lib/createPassword";
import { loadSettings, saveSettings, type AppSettings } from "./lib/settings";
import { startChiptune } from "./lib/chiptune";
import DropZone from "./components/DropZone";
import ArchiveView from "./components/ArchiveView";
import CreatePanel from "./components/CreatePanel";
import SettingsPanel from "./components/SettingsPanel";
import SplitPanel from "./components/SplitPanel";
import PreviewModal, { type PreviewData } from "./components/PreviewModal";
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
    extensions: [
      "zip",
      "rar",
      "7z",
      "jar",
      "001",
      "gz",
      "tgz",
      "xz",
      "txz",
      "zst",
      "tzst",
      "tar",
    ],
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
  // Format de l'archive créée (ZIP par défaut, 7z disponible).
  const [createFormat, setCreateFormat] = useState<CreateFormat>("zip");
  // Chiffrement de l'archive créée (AES-256) : activation + saisie.
  const [encryptionEnabled, setEncryptionEnabled] = useState(false);
  const [createPassword, setCreatePassword] = useState("");
  const [createPasswordConfirm, setCreatePasswordConfirm] = useState("");
  const createPwdError = createPasswordError(
    encryptionEnabled,
    createPassword,
    createPasswordConfirm,
  );
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Découpe en volumes : modale de choix de la taille des parties.
  const [splitOpen, setSplitOpen] = useState(false);
  // Aperçu d'une entrée (texte/image), sans extraction.
  const [preview, setPreview] = useState<PreviewData | null>(null);
  // Archives récemment ouvertes (stockage local).
  const [history, setHistory] = useState<RecentArchive[]>(() => loadHistory());
  const [confirmClose, setConfirmClose] = useState(false);
  // Archive dont la lecture (ou l'extraction) a échoué : mot de passe
  // probablement requis. `pendingExtract` garde les paramètres d'une
  // extraction échouée pour rejouer avec le mot de passe saisi.
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [pendingPassword, setPendingPassword] = useState("");
  const [pendingExtract, setPendingExtract] = useState<{
    destDir: string;
    selection: string[];
  } | null>(null);
  // Easter egg : dernier résultat d'opération, affiché par la séquence « JIMBO ».
  const [lastResult, setLastResult] = useState<OperationResult | null>(null);
  const [showBalatro, setShowBalatro] = useState(false);
  const [balatroPraise, setBalatroPraise] = useState("EXCELLENT !");
  // Mode Balatro complet (thème animé), basculé par la séquence « JIMBO ».
  const [balatroMode, setBalatroMode] = useState(false);
  // Opérations longues : progression (barre) et annulation. `cancellable`
  // distingue les opérations annulables (extraction, création) du listing,
  // qui ne consulte pas les jetons d'annulation.
  const [progress, setProgress] = useState<OperationProgress | null>(null);
  const [cancellable, setCancellable] = useState(false);
  const [extractDest, setExtractDest] = useState<string | null>(null);
  const opIdRef = useRef("");
  // Le handler de glisser-déposer doit ignorer les drops pendant une
  // opération même quand sa closure est déjà enregistrée.
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  // Progression émise par le backend, filtrée sur l'opération en cours.
  useEffect(() => {
    const unlisten = listen<OperationProgress>(
      "operation-progress",
      (event) => {
        if (event.payload.id === opIdRef.current) {
          setProgress(event.payload);
        }
      },
    );
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  /** Démarre une opération annulable : nouvel identifiant d'annulation. */
  const beginOperation = () => {
    const id = crypto.randomUUID();
    opIdRef.current = id;
    setProgress(null);
    setCancellable(true);
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

  // Effets CRT : scanlines désactivables (lisibilité) via data-crt="off".
  useEffect(() => {
    const root = document.documentElement;
    if (settings.crtEffects) {
      delete root.dataset.crt;
    } else {
      root.dataset.crt = "off";
    }
  }, [settings.crtEffects]);

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
    if (!status || status.kind === "error" || !settings.autoDismissStatus)
      return;
    const timer = window.setTimeout(
      () => setStatus(null),
      STATUS_AUTO_DISMISS_MS,
    );
    return () => window.clearTimeout(timer);
  }, [status, settings.autoDismissStatus]);

  const closeArchive = () => {
    if (settings.confirmBeforeClose && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    // Réarme la confirmation : la prochaine archive ne doit pas se
    // fermer en un seul clic tant que le délai n'est pas écoulé.
    setConfirmClose(false);
    setArchive(null);
  };

  const openArchive = useCallback(
    async (path: string, password: string | null = null, announce = true) => {
      const name = fileNameOf(path);
      const format = detectFormat(name);
      if (!format) {
        setStatus({
          kind: "error",
          message: `Format non pris en charge : ${name}`,
        });
        return;
      }
      // Le listing n'est ni annulable ni progressive : masque le bouton
      // ANNULER d'une opération précédente (ex. création terminée).
      setCancellable(false);
      setProgress(null);
      setBusy(true);
      setStatus(null);
      try {
        const rawEntries = await listArchive(path, password);
        const entries = sortEntries(implicitDirectories(rawEntries));
        setArchive({ path, name, format, entries });
        setHistory(pushRecentArchive(path));
        setPendingPath(null);
        setPendingExtract(null);
        if (announce) {
          setStatus({
            kind: "info",
            message: `${entries.filter((e) => !e.isDir).length} fichier(s) — ${name}`,
          });
        }
      } catch (error) {
        const appError = asAppError(error);
        setStatus({
          kind: "error",
          message: `Impossible de lire l'archive : ${appError.message}`,
        });
        // Le prompt de mot de passe n'apparaît que si le backend signale
        // un mot de passe manquant/incorrect (pas pour un fichier corrompu).
        if (appError.kind === "passwordRequired") {
          setPendingPath(path);
        }
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const chooseArchive = useCallback(async () => {
    const path = await open({ multiple: false, filters: ARCHIVE_FILTERS });
    if (typeof path === "string" && path.length > 0) {
      await openArchive(path);
    }
  }, [openArchive]);

  // Glisser-déposer d'une archive sur la fenêtre (Tauri uniquement).
  // Seule la première archive est ouverte.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const paths = event.payload.paths;
      const path = paths[0];
      if (!path) return;
      if (busyRef.current) {
        setStatus({
          kind: "info",
          message:
            "Opération en cours — impossible d'ouvrir une autre archive.",
        });
        return;
      }
      void (async () => {
        await openArchive(path);
        if (paths.length > 1) {
          setStatus({
            kind: "info",
            message: `${paths.length} éléments déposés — seule « ${fileNameOf(path)} » a été ouverte.`,
          });
        }
      })();
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
          message: `${result.files} fichier(s) · ${formatBytes(result.bytes)} extraits en ${formatDuration(result.elapsedMs)} vers ${destDir}`,
        });
        setLastResult(result);
        setExtractDest(destDir);
        setPendingPath(null);
        setPendingExtract(null);
      } catch (error) {
        const appError = asAppError(error);
        if (appError.kind === "cancelled") {
          setStatus({ kind: "info", message: "Extraction annulée." });
        } else {
          setStatus({
            kind: "error",
            message: `Échec de l'extraction : ${appError.message}`,
          });
          // Comme pour le listing : prompt de mot de passe si le backend
          // signale un mot de passe manquant/incorrect (pas si corrompu).
          if (appError.kind === "passwordRequired") {
            setPendingPath(archive.path);
            setPendingExtract({ destDir, selection });
          }
        }
      } finally {
        setBusy(false);
        setProgress(null);
        setCancellable(false);
      }
    },
    [archive],
  );

  const handleCreate = useCallback(
    async (
      dest: string,
      sources: string[],
      password: string | null,
      format: CreateFormat,
    ) => {
      const id = beginOperation();
      setBusy(true);
      setStatus(null);
      try {
        const result =
          format === "sevenz"
            ? await createSevenz(id, dest, sources, password)
            : format === "targz" || format === "tarzst"
              ? await createTar(id, dest, sources, format)
              : await createZip(id, dest, sources, password);
        setStatus({
          kind: "success",
          message: `${result.files} fichier(s) · ${formatBytes(result.bytes)} compressé(s) en ${formatDuration(result.elapsedMs)} → ${dest}${
            password ? " (chiffrée AES-256)" : ""
          }`,
        });
        setLastResult(result);
        setCreating(false);
        // Ouverture silencieuse avec le mot de passe éventuel : une 7z
        // chiffrée a son en-tête protégé, le listing l'exige donc.
        await openArchive(dest, password, false);
      } catch (error) {
        const appError = asAppError(error);
        if (appError.kind === "cancelled") {
          setStatus({ kind: "info", message: "Création annulée." });
        } else {
          setStatus({
            kind: "error",
            message: `Échec de la création : ${appError.message}`,
          });
        }
      } finally {
        setBusy(false);
        setProgress(null);
        setCancellable(false);
      }
    },
    [openArchive],
  );

  // Test d'intégrité : vérifie toutes les entrées (CRC) sans extraction.
  const handleTest = useCallback(
    async (password: string | null) => {
      if (!archive) return;
      const id = beginOperation();
      setBusy(true);
      setStatus(null);
      try {
        const result = await testArchive(id, archive.path, password);
        setStatus({
          kind: "success",
          message: `${archive.name} est intègre — ${result.files} fichier(s) · ${formatBytes(result.bytes)} vérifiés en ${formatDuration(result.elapsedMs)}`,
        });
      } catch (error) {
        const appError = asAppError(error);
        if (appError.kind === "cancelled") {
          setStatus({ kind: "info", message: "Test annulé." });
        } else if (appError.kind === "passwordRequired") {
          setStatus({
            kind: "error",
            message: `Test impossible — mot de passe requis : ${appError.message}`,
          });
          setPendingPath(archive.path);
        } else {
          setStatus({
            kind: "error",
            message: `Archive endommagée : ${appError.message}`,
          });
        }
      } finally {
        setBusy(false);
        setProgress(null);
        setCancellable(false);
      }
    },
    [archive],
  );

  // Découpe de l'archive ouverte en volumes (dest.001, .002, …).
  const handleSplit = useCallback(
    async (partSize: number) => {
      if (!archive) return;
      setSplitOpen(false);
      // Le nom de base est libre : l'utilisateur choisit la destination.
      const destBase = await save({
        title: "Nom de base des volumes",
        filters: [],
      });
      if (typeof destBase !== "string" || destBase.length === 0) return;
      const id = beginOperation();
      setBusy(true);
      setStatus(null);
      try {
        const result = await splitArchive(id, archive.path, destBase, partSize);
        setLastResult(result);
        setStatus({
          kind: "success",
          message: `Archive découpée en ${result.files} volume(s) · ${formatBytes(result.bytes)} en ${formatDuration(result.elapsedMs)} → ${destBase}.001`,
        });
      } catch (error) {
        const appError = asAppError(error);
        if (appError.kind === "cancelled") {
          setStatus({ kind: "info", message: "Découpe annulée." });
        } else {
          setStatus({
            kind: "error",
            message: `Échec de la découpe : ${appError.message}`,
          });
        }
      } finally {
        setBusy(false);
        setProgress(null);
        setCancellable(false);
      }
    },
    [archive],
  );

  // Aperçu d'une entrée : lecture mémoire côté backend, aucun fichier écrit.
  const handlePreview = useCallback(
    async (entryPath: string, password: string | null) => {
      if (!archive) return;
      setBusy(true);
      setStatus(null);
      try {
        const payload = await previewEntry(archive.path, entryPath, password);
        setPreview({
          entryName: fileNameOf(entryPath),
          kind: payload.kind,
          mime: payload.mime,
          content: payload.content,
        });
      } catch (error) {
        const appError = asAppError(error);
        setStatus({
          kind: "error",
          message: `Aperçu impossible : ${appError.message}`,
        });
      } finally {
        setBusy(false);
      }
    },
    [archive],
  );

  // Somme SHA-256 de l'archive (volumes réassemblés au besoin).
  const handleChecksum = useCallback(async () => {
    if (!archive) return;
    setBusy(true);
    setStatus(null);
    try {
      const result = await checksumArchive(archive.path);
      setStatus({
        kind: "success",
        message: `SHA-256 (${formatBytes(result.bytes)}) — ${result.fileName}`,
        checksum: result.checksum,
      });
    } catch (error) {
      const appError = asAppError(error);
      setStatus({
        kind: "error",
        message: `Échec du calcul : ${appError.message}`,
      });
    } finally {
      setBusy(false);
    }
  }, [archive]);

  // Export du fichier .sha256 à l'emplacement choisi.
  const handleExportChecksum = useCallback(async () => {
    if (!archive || !status?.checksum) return;
    const dest = await save({
      title: "Exporter la somme SHA-256",
      defaultPath: `${archive.path}.sha256`,
      filters: [{ name: "Somme SHA-256", extensions: ["sha256"] }],
    });
    if (typeof dest !== "string" || dest.length === 0) return;
    setBusy(true);
    try {
      await exportChecksum(archive.path, dest);
      setStatus({
        kind: "success",
        message: `Somme SHA-256 exportée → ${dest}`,
        // Le hash reste affiché (copiable) après l'export.
        checksum: status.checksum,
      });
    } catch (error) {
      const appError = asAppError(error);
      setStatus({
        kind: "error",
        message: `Échec de l'export : ${appError.message}`,
      });
    } finally {
      setBusy(false);
    }
  }, [archive, status]);

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
      // Nouvelle session de création : saisie et format réinitialisés.
      setCreateFormat("zip");
      setEncryptionEnabled(false);
      setCreatePassword("");
      setCreatePasswordConfirm("");
    }
  }, []);

  // Ajoute des sources supplémentaires (fichiers ou dossiers) à l'archive
  // en cours de création, sans doublons.
  const addCreateSources = useCallback(async (directory: boolean) => {
    const picked = await open({
      multiple: true,
      directory,
      ...(directory
        ? {}
        : { filters: [{ name: "Tous les fichiers", extensions: ["*"] }] }),
    });
    if (Array.isArray(picked) && picked.length > 0) {
      setSources((prev) => [...new Set([...prev, ...picked])]);
      setCreating(true);
    }
  }, []);

  const retryWithPassword = useCallback(() => {
    if (!pendingPath) return;
    const password = pendingPassword.length > 0 ? pendingPassword : null;
    // Extraction échouée : on rejoue avec le mot de passe saisi ; sinon,
    // on relance le listing.
    if (pendingExtract) {
      void handleExtract(
        pendingExtract.destDir,
        password,
        pendingExtract.selection,
      );
    } else {
      void openArchive(pendingPath, password);
    }
  }, [
    pendingPath,
    pendingExtract,
    pendingPassword,
    openArchive,
    handleExtract,
  ]);

  const pickSavePath = useCallback(
    async (sources: string[]) => {
      // Le mot de passe est validé avant même le choix de l'emplacement.
      const password = effectiveCreatePassword(
        encryptionEnabled,
        createPassword,
        createPasswordConfirm,
      );
      if (encryptionEnabled && password === null) {
        setStatus({
          kind: "error",
          message: createPwdError ?? "Mot de passe invalide.",
        });
        return;
      }
      const filters =
        createFormat === "sevenz"
          ? [{ name: "Archive 7z", extensions: ["7z"] }]
          : createFormat === "targz"
            ? [{ name: "Archive TAR.GZ", extensions: ["gz", "tgz"] }]
            : createFormat === "tarzst"
              ? [{ name: "Archive TAR.ZST", extensions: ["zst", "tzst"] }]
              : [{ name: "Archive ZIP", extensions: ["zip"] }];
      const dest = await save({ filters });
      if (typeof dest === "string" && dest.length > 0) {
        await handleCreate(dest, sources, password, createFormat);
      }
    },
    [
      handleCreate,
      createFormat,
      encryptionEnabled,
      createPassword,
      createPasswordConfirm,
      createPwdError,
    ],
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
      if (
        event.key.length !== 1 ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        tag === "INPUT" ||
        tag === "TEXTAREA"
      ) {
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
      {busy && cancellable && (
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
          <button onClick={() => void pickCreateFiles()} disabled={busy}>
            Nouvelle archive…
          </button>
          {archive && (
            <button className="ghost" onClick={closeArchive} disabled={busy}>
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

      {splitOpen && archive && (
        <SplitPanel
          archiveName={archive.name}
          onPick={(partSize) => void handleSplit(partSize)}
          onClose={() => setSplitOpen(false)}
        />
      )}

      {preview && (
        <PreviewModal preview={preview} onClose={() => setPreview(null)} />
      )}

      {status && (
        <div
          className={`status status-${status.kind}`}
          role={status.kind === "error" ? "alert" : "status"}
        >
          {(() => {
            const StatusIcon = STATUS_ICONS[status.kind];
            return <StatusIcon className="status-icon" />;
          })()}
          <span className="status-message">{status.message}</span>
          {status.kind === "success" && status.checksum && (
            <>
              <code className="status-hash">{status.checksum}</code>
              <button
                className="status-action"
                onClick={() =>
                  void navigator.clipboard.writeText(status.checksum ?? "")
                }
              >
                Copier
              </button>
              <button
                className="status-action"
                onClick={() => void handleExportChecksum()}
              >
                Exporter…
              </button>
            </>
          )}
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
            {pendingExtract
              ? `Extraction de « ${fileNameOf(pendingPath)} » impossible — mot de passe requis ?`
              : `Lecture de « ${fileNameOf(pendingPath)} » impossible — mot de passe requis ?`}
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
          <button
            className="ghost"
            onClick={() => {
              setPendingPath(null);
              setPendingExtract(null);
            }}
          >
            Annuler
          </button>
        </div>
      )}

      <main className="main">
        {creating ? (
          <CreatePanel
            busy={busy}
            sources={sources}
            format={createFormat}
            encryptionEnabled={encryptionEnabled}
            password={createPassword}
            passwordConfirm={createPasswordConfirm}
            passwordError={createPwdError}
            onCancel={() => setCreating(false)}
            onCreate={() => void pickSavePath(sources)}
            onAddFiles={() => void addCreateSources(false)}
            onAddDir={() => void addCreateSources(true)}
            onFormatChange={setCreateFormat}
            onToggleEncryption={setEncryptionEnabled}
            onPasswordChange={setCreatePassword}
            onPasswordConfirmChange={setCreatePasswordConfirm}
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
            onTest={(password) => void handleTest(password)}
            onSplit={() => setSplitOpen(true)}
            onChecksum={() => void handleChecksum()}
            onPreview={(entryPath, password) =>
              void handlePreview(entryPath, password)
            }
          />
        ) : (
          <>
            <DropZone busy={busy} onPick={() => void chooseArchive()} />
            {history.length > 0 && (
              <section className="history-panel" aria-label="Archives récentes">
                <h2>Récentes</h2>
                <ul>
                  {history.map((recent) => (
                    <li key={recent.path}>
                      <button
                        className="history-item"
                        disabled={busy}
                        title={recent.path}
                        onClick={() => void openArchive(recent.path)}
                      >
                        {recent.name}
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  className="ghost"
                  onClick={() => {
                    clearHistory();
                    setHistory([]);
                  }}
                >
                  Effacer l'historique
                </button>
              </section>
            )}
          </>
        )}
      </main>

      <footer className="footer">
        <span>
          LibreRAR — gestionnaire d'archives libre · RAR (lecture), ZIP, 7z,
          TAR, volumes
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
