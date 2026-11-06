import { useState } from "react";
import { parseSplitSizeMB, splitSizeBytes } from "../lib/splitSize";
import { useModalDialog } from "../lib/useModalDialog";
import { XIcon } from "./Icons";

export const SPLIT_SIZES: { label: string; mib: number }[] = [
  { label: "10 Mo", mib: 10 },
  { label: "100 Mo", mib: 100 },
  { label: "1 Go", mib: 1024 },
];

interface SplitPanelProps {
  archiveName: string;
  /** `partBytes` : taille de volume en octets ; `mib` : taille libre en Mio. */
  onPick: (partSize: number) => void;
  onClose: () => void;
}

/**
 * Choix de la taille des volumes pour la découpe d'une archive, en
 * fenêtre modale : tailles proposées ou saisie libre (Mio).
 */
export default function SplitPanel({
  archiveName,
  onPick,
  onClose,
}: SplitPanelProps) {
  const dialogRef = useModalDialog(onClose);
  const [customSize, setCustomSize] = useState("");
  const [sizeError, setSizeError] = useState<string | null>(null);

  const submitCustom = () => {
    const mib = parseSplitSizeMB(customSize);
    if (mib === null) {
      setSizeError("Taille invalide — saisir un nombre en Mo (ex. 250).");
      return;
    }
    onPick(splitSizeBytes(mib));
  };

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Découper l'archive en volumes"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal-title">
          <h2>Découper « {archiveName} »</h2>
          <button className="ghost" onClick={onClose} aria-label="Fermer">
            <XIcon />
          </button>
        </div>
        <p>
          Choisir la taille de chaque volume — les parties seront nommées
          nnn.001, nnn.002, … et réassemblées automatiquement à l'ouverture.
        </p>
        <div className="split-sizes">
          {SPLIT_SIZES.map((size) => (
            <button
              key={size.label}
              onClick={() => onPick(splitSizeBytes(size.mib))}
            >
              {size.label}
            </button>
          ))}
        </div>
        <div className="split-custom">
          <label htmlFor="split-custom-size">Ou une taille (Mo)</label>
          <input
            id="split-custom-size"
            type="text"
            inputMode="decimal"
            placeholder="250"
            value={customSize}
            aria-invalid={!!sizeError}
            onChange={(e) => {
              setCustomSize(e.target.value);
              setSizeError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitCustom();
            }}
          />
          <button className="primary" onClick={submitCustom}>
            Découper
          </button>
        </div>
        {sizeError && (
          <p className="create-password-error" role="alert">
            {sizeError}
          </p>
        )}
      </div>
    </div>
  );
}
