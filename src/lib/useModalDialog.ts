import { useEffect, useRef } from "react";

/**
 * Comportement commun des fenêtres modales : focus déplacé dans la boîte à
 * l'ouverture, piège de focus (Tab et Maj+Tab restent à l'intérieur),
 * fermeture par Échap, et focus restitué à l'élément d'ouverture à la
 * fermeture. L'effet tourne une seule fois (montage) : le retour de focus
 * ne doit pas viser un élément intérieur à la boîte disparue, et les
 * identités de callbacks parents n'y changent rien.
 */
export function useModalDialog(onClose: () => void) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  // Assigné en effet (jamais pendant le rendu) : la fermeture vue par le
  // gestionnaire est toujours la dernière identité passée par le parent.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    // Élément ayant ouvert la modale : restitué à la fermeture.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialogRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusables = dialogRef.current?.querySelectorAll<HTMLElement>(
        "button, input, [href]",
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, []);

  return dialogRef;
}
