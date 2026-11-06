import { invoke } from "@tauri-apps/api/core";
import type { ArchiveEntry, ArchiveFormat, OperationResult } from "../types";

/** Progression d'une opération, émise par le backend. */
export interface OperationProgress {
  id: string;
  done: number;
  total: number;
  current: string;
}

/** Erreur structurée renvoyée par les commandes Rust (`{ kind, message }`). */
export interface AppError {
  kind: "cancelled" | "passwordRequired" | "failed";
  message: string;
}

/**
 * Normalise une erreur IPC : les commandes Rust renvoient une `AppError`
 * sérialisée ; tout le reste (interruption IPC, chaîne brute) est
 * traité comme un échec générique.
 */
export function asAppError(error: unknown): AppError {
  if (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    "message" in error &&
    typeof (error as AppError).message === "string"
  ) {
    const { kind } = error as { kind: unknown };
    if (
      kind === "cancelled" ||
      kind === "passwordRequired" ||
      kind === "failed"
    ) {
      return error as AppError;
    }
  }
  return { kind: "failed", message: String(error) };
}

export function detectFormat(fileName: string): ArchiveFormat | null {
  // Une partie de volume (xxx.zip.001) est nommée par sa base : le format
  // est détecté après avoir retiré le suffixe de partie.
  const candidate = fileName.replace(/\.\d{3}$/, "");
  const lower = (candidate || fileName).toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".jar")) return "zip";
  if (lower.endsWith(".rar")) return "rar";
  if (lower.endsWith(".7z")) return "sevenz";
  if (lower.endsWith(".tar")) return "tar";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "targz";
  if (lower.endsWith(".tar.xz") || lower.endsWith(".txz")) return "tarxz";
  if (lower.endsWith(".tar.zst") || lower.endsWith(".tzst")) return "tarzst";
  return null;
}

export function listArchive(
  path: string,
  password: string | null = null,
): Promise<ArchiveEntry[]> {
  return invoke<ArchiveEntry[]>("list_archive", { path, password });
}

export function extractArchive(
  id: string,
  path: string,
  destDir: string,
  password: string | null,
  entries: string[] | null,
): Promise<OperationResult> {
  return invoke<OperationResult>("extract_archive", {
    id,
    path,
    destDir,
    password,
    entries,
  });
}

export function createZip(
  id: string,
  dest: string,
  sources: string[],
  password: string | null = null,
): Promise<OperationResult> {
  return invoke<OperationResult>("create_zip", { id, dest, sources, password });
}

export function createSevenz(
  id: string,
  dest: string,
  sources: string[],
  password: string | null = null,
): Promise<OperationResult> {
  return invoke<OperationResult>("create_sevenz", {
    id,
    dest,
    sources,
    password,
  });
}

/** Crée une archive TAR compressée (variante « targz » ou « tarzst »). */
export function createTar(
  id: string,
  dest: string,
  sources: string[],
  variant: "targz" | "tarzst",
): Promise<OperationResult> {
  return invoke<OperationResult>("create_tar", { id, dest, sources, variant });
}

/** Demande l'annulation de l'opération identifiée par `id`. */
export function cancelOperation(id: string): Promise<void> {
  return invoke<void>("cancel_operation", { id });
}

/** Découpe une archive en volumes de `partSize` octets (dest.001, …). */
export function splitArchive(
  id: string,
  src: string,
  destBase: string,
  partSize: number,
): Promise<OperationResult> {
  return invoke<OperationResult>("split_archive", {
    id,
    src,
    destBase: destBase,
    partSize: partSize,
  });
}

/** Teste l'intégrité de toutes les entrées (CRC) sans extraction. */
export function testArchive(
  id: string,
  path: string,
  password: string | null = null,
): Promise<OperationResult> {
  return invoke<OperationResult>("test_archive", { id, path, password });
}

export interface PreviewPayload {
  kind: "text" | "image";
  mime: string;
  content: string;
  truncated: boolean;
}

/** Contenu d'une entrée pour aperçu (texte ou image), sans extraction. */
export function previewEntry(
  path: string,
  entryName: string,
  password: string | null = null,
): Promise<PreviewPayload> {
  return invoke<PreviewPayload>("preview_entry", { path, entryName, password });
}

export interface ChecksumResult {
  checksum: string;
  bytes: number;
  fileName: string;
}

/** Somme SHA-256 de l'archive (volumes réassemblés au besoin). */
export function checksumArchive(path: string): Promise<ChecksumResult> {
  return invoke<ChecksumResult>("checksum_archive", { path });
}

/** Écrit un fichier `.sha256` à l'emplacement choisi. */
export function exportChecksum(path: string, dest: string): Promise<void> {
  return invoke<void>("export_checksum", { path, dest });
}
