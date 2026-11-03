import { invoke } from "@tauri-apps/api/core";
import type { ArchiveEntry, ArchiveFormat, OperationResult } from "../types";

export function detectFormat(fileName: string): ArchiveFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".zip") || lower.endsWith(".jar")) return "zip";
  if (lower.endsWith(".rar")) return "rar";
  if (lower.endsWith(".7z")) return "sevenz";
  return null;
}

export function listArchive(path: string): Promise<ArchiveEntry[]> {
  return invoke<ArchiveEntry[]>("list_archive", { path });
}

export function extractArchive(
  path: string,
  destDir: string,
  password: string | null,
  entries: string[] | null,
): Promise<OperationResult> {
  return invoke<OperationResult>("extract_archive", {
    path,
    destDir,
    password,
    entries,
  });
}

export function createZip(
  dest: string,
  sources: string[],
): Promise<OperationResult> {
  return invoke<OperationResult>("create_zip", { dest, sources });
}
