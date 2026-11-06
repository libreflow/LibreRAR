import { useModalDialog } from "../lib/useModalDialog";
import { XIcon } from "./Icons";

export interface PreviewData {
  entryName: string;
  kind: "text" | "image";
  mime: string;
  content: string;
}

interface PreviewModalProps {
  preview: PreviewData;
  onClose: () => void;
}

/** Aperçu d'une entrée (texte ou image) sans extraction sur disque. */
export default function PreviewModal({ preview, onClose }: PreviewModalProps) {
  const dialogRef = useModalDialog(onClose);

  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal preview-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Aperçu de ${preview.entryName}`}
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal-title">
          <h2>Aperçu — {preview.entryName}</h2>
          <button className="ghost" onClick={onClose} aria-label="Fermer">
            <XIcon />
          </button>
        </div>
        {preview.kind === "text" ? (
          <pre className="preview-text">{preview.content}</pre>
        ) : (
          <img
            className="preview-img"
            src={`data:${preview.mime};base64,${preview.content}`}
            alt={preview.entryName}
          />
        )}
      </div>
    </div>
  );
}
