import { useEffect } from "react";

interface BalatroPopupProps {
  /** Éloge affiché en titre. */
  praise: string;
  /** Légende sous le score (annonce l'état du mode Balatro). */
  caption: string;
  /** Valeur affichée dans le bloc CHIPS (bleu). */
  chips: string;
  /** Valeur affichée dans le bloc MULT (rouge). */
  mult: string;
  onDone: () => void;
}

// Éloges façon fin de manche Balatro.
export const PRAISE = [
  "EXCELLENT !",
  "FANTASTIQUE !",
  "IMPARABLE !",
  "INCROYABLE !",
  "LEGENDAIRE !",
] as const;

/** À appeler hors rendu (gestionnaire d'événement) : tire l'éloge au hasard. */
export function pickPraise(): string {
  return PRAISE[Math.floor(Math.random() * PRAISE.length)];
}

/**
 * Easter egg : tapez « JIMBO » hors champ de saisie. Affiche le score de la
 * dernière opération (octets × fichiers) dans le style de Balatro.
 * Décoratif — caché aux lecteurs d'écran.
 */
export default function BalatroPopup({ praise, caption, chips, mult, onDone }: BalatroPopupProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDone, 4500);
    return () => window.clearTimeout(timer);
  }, [onDone]);

  return (
    <div
      className="balatro-popup"
      onClick={onDone}
      title="Fermer"
      aria-hidden="true"
    >
      <span className="balatro-title">{praise}</span>
      <div className="balatro-score">
        <span className="balatro-chips">
          <span className="balatro-label">CHIPS</span>
          {chips}
        </span>
        <span className="balatro-times">×</span>
        <span className="balatro-mult">
          <span className="balatro-label">MULT</span>
          {mult}
        </span>
      </div>
      <span className="balatro-caption">{caption}</span>
    </div>
  );
}
