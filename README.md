# LibreRAR

Gestionnaire d'archives libre pour le bureau — alternative libre à WinRAR.

**LibreRAR** permet d'explorer, d'extraire et de créer des archives directement
depuis une application native légère (Tauri 2 + React), avec une interface en
français.

## Fonctionnalités

- **Ouvrir et explorer** : RAR (lecture), ZIP, JAR et 7z
- **Extraire** : archive complète ou sélection d'entrées, avec mot de passe
  (ZipCrypto/AES pour ZIP, RAR, 7z AES-256)
- **Créer** : archives ZIP (Deflate, compression multi-cœur) et 7z (LZMA2),
  fichiers et dossiers récursifs, avec mot de passe optionnel (chiffrement
  AES-256 — jamais ZipCrypto)
- **Glisser-déposer** d'une archive sur la fenêtre pour l'ouvrir
- **Sécurité** : refus des chemins malveillants (« zip-slip ») à l'extraction

> La _création_ d'archives RAR n'est pas possible : le format RAR est
> propriétaire. La lecture s'appuie sur le code source officiel UnRAR
> (gratuiciel). Les formats entièrement libres (ZIP, 7z) sont lisibles **et**
> modifiables.

## Captures d'écran

_(à venir)_

## Installation

### Prérequis

- [Node.js](https://nodejs.org) ≥ 20
- [Rust](https://www.rust-lang.org/tools/install) (toolchain stable)

### Développement

```bash
npm install
npm run tauri dev
```

### Tests et vérifications

```bash
npm test          # tests frontend (vitest) — le backend Rust est testé via cargo test
npm run lint      # eslint
npm run build     # tsc + vite build
cd src-tauri && cargo test   # tests backend (zip-slip, round-trip ZIP/7z)
```

### Compilation de l'application

```bash
npm run tauri build
```

Les installateurs sont générés dans `src-tauri/target/release/bundle/`.

## Architecture

```
├── src/                     # Frontend React + TypeScript
│   ├── App.tsx               # orchestration (ouverture, extraction, création)
│   ├── components/           # DropZone, ArchiveView, CreatePanel
│   └── lib/                  # API IPC, formatage, filtrage (testés)
├── src-tauri/
│   ├── src/lib.rs            # commandes Tauri : list/extract/create
│   └── capabilities/         # permissions au moindre privilège
└── scripts/generate_icon.py  # source de l'icône (PIL)
```

Formats gérés par le backend :

| Format  | Lecture | Extraction     | Création          | Crate         |
| ------- | ------- | -------------- | ----------------- | ------------- |
| ZIP/JAR | ✅      | ✅ (sélective) | ✅                | `zip`         |
| RAR     | ✅      | ✅ (sélective) | ❌ (propriétaire) | `unrar`       |
| 7z      | ✅      | ✅ (sélective) | ✅ (LZMA2)        | `sevenz-rust` |

## Licence

MIT — voir [LICENSE](LICENSE).
