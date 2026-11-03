interface DropZoneProps {
  busy: boolean;
  onPick: () => void;
}

export default function DropZone({ busy, onPick }: DropZoneProps) {
  return (
    <div className="dropzone" aria-busy={busy}>
      <div className="dropzone-icon">📦</div>
      <h2>Déposez une archive ici</h2>
      <p>RAR, ZIP et 7z — ou parcourez vos fichiers</p>
      <button onClick={onPick} disabled={busy} autoFocus>
        Parcourir…
      </button>
    </div>
  );
}
