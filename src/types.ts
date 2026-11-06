export interface ArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
}

export interface OperationResult {
  files: number;
  bytes: number;
  /** Durée de l'opération en millisecondes. */
  elapsedMs: number;
}

export type ArchiveFormat = "zip" | "rar" | "sevenz";

/** Formats proposés lors de la création d'une archive. */
export type CreateFormat = "zip" | "sevenz";

export type StatusKind = "info" | "success" | "error";

export interface Status {
  kind: StatusKind;
  message: string;
}
