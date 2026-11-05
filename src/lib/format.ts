export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes === 0) return "0 o";
  const units = ["o", "Ko", "Mo", "Go", "To"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 2 ** (10 * exponent);
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[exponent]}`;
}

export function compressionRatio(size: number, compressedSize: number): string {
  if (size <= 0 || compressedSize <= 0) return "—";
  const ratio = (compressedSize / size) * 100;
  if (ratio > 999) return "999 %+";
  return `${Math.round(ratio)} %`;
}

/** Formate une durée en millisecondes : « 245 ms », « 1,3 s ». */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export function fileNameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

export function entryBaseName(entryPath: string): string {
  const clean = entryPath.replace(/\/+$/, "");
  return fileNameOf(clean);
}
