import type { CreateFormat } from "../types";

/** Suffixes attendus par format de création (côté ouverture). */
const CREATE_SUFFIX: Record<CreateFormat, string> = {
  zip: ".zip",
  sevenz: ".7z",
  targz: ".tar.gz",
  tarzst: ".tar.zst",
};

const KNOWN_EXTENSIONS = /\.(zip|7z|gz|tgz|zst|tzst|tar)$/i;

/**
 * Normalise la destination choisie : le suffixe doit correspondre au
 * format demandé, sinon l'archive créée serait indétectable à
 * l'ouverture (« x.gz » seul n'est pas reconnu comme tar.gz). Les
 * extensions connues préexistantes sont remplacées, les fichiers
 * nommés sans extension en reçoivent une.
 *
 *     ensureCreateExtension("vacances", "targz")  → "vacances.tar.gz"
 *     ensureCreateExtension("a.gz", "targz")     → "a.tar.gz"
 *     ensureCreateExtension("b.tar.gz", "targz") → "b.tar.gz"
 *     ensureCreateExtension("c.old.zip", "zip")  → "c.old.zip"
 */
export function ensureCreateExtension(
  fileName: string,
  format: CreateFormat,
): string {
  const suffix = CREATE_SUFFIX[format];
  if (fileName.toLowerCase().endsWith(suffix)) return fileName;
  let base = fileName;
  while (KNOWN_EXTENSIONS.test(base)) {
    base = base.replace(KNOWN_EXTENSIONS, "");
  }
  return `${base}${suffix}`;
}
