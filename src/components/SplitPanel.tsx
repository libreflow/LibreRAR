import { useEffect, useRef } from "react";
import { XIcon } from "./Icons";

export const SPLIT_SIZES: { label: string; bytes: number }[] = [
  { label: "10 Mo", bytes: 10 * 1024 * 1024 },
  { label: "100 Mo", bytes: 100 * 1024 * 1024 },
  { label: "1 Go", bytes: 1024 * 1024 * 1024 },
];

interface SplitPanelProps {
  archiveName: string;
  onPick: (partSize: number) => void;
  onClose: () => void;
}

/**
 * Choix de la taille des volumes pour la découpe d'une archive, en
 * fenêtre modale : fermeture par Échap ou clic sur l'arrière-plan.
 */
export default function SplitPanel({
  archiveName,
  onPick,
  onClose,
}: SplitPanelProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
            <button key={size.label} onClick={() => onPick(size.bytes)}>
              {size.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
