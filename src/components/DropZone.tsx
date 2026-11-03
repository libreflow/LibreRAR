import { PackageIcon } from "./Icons";

interface DropZoneProps {
  busy: boolean;
  onPick: () => void;
}

export default function DropZone({ busy, onPick }: DropZoneProps) {
  return (
    <div className="dropzone" aria-busy={busy}>
      <PackageIcon className="dropzone-icon" />
      <h2>Déposez une archive ici</h2>
      <p className="dropzone-formats">RAR · ZIP · 7Z</p>
      <p>ou parcourez vos fichiers</p>
      <button onClick={onPick} disabled={busy} autoFocus>
        Parcourir…
      </button>
    </div>
  );
}
