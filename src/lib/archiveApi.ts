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
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".jar")) return "zip";
  if (lower.endsWith(".rar")) return "rar";
  if (lower.endsWith(".7z")) return "sevenz";
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

/** Demande l'annulation de l'opération identifiée par `id`. */
export function cancelOperation(id: string): Promise<void> {
  return invoke<void>("cancel_operation", { id });
}
