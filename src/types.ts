export interface ArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
  /** null/absent : caractère chiffré inconnu (RAR, 7z) ; false : jamais. */
  encrypted?: boolean | null;
}

export interface OperationResult {
  files: number;
  bytes: number;
  /** Durée de l'opération en millisecondes. */
  elapsedMs: number;
}

export type ArchiveFormat =
  "zip" | "rar" | "sevenz" | "tar" | "targz" | "tarxz" | "tarzst";

/** Formats proposés lors de la création d'une archive. */
export type CreateFormat = "zip" | "sevenz" | "targz" | "tarzst";

export type StatusKind = "info" | "success" | "error";

export interface Status {
  kind: StatusKind;
  message: string;
  /** somme SHA-256 affichée avec action « Copier » */
  checksum?: string;
}
