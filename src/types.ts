export interface ArchiveEntry {
  path: string;
  size: number;
  compressedSize: number;
  isDir: boolean;
}

export interface OperationResult {
  files: number;
  bytes: number;
}

export type ArchiveFormat = "zip" | "rar" | "sevenz";

export type StatusKind = "info" | "success" | "error";

export interface Status {
  kind: StatusKind;
  message: string;
}
