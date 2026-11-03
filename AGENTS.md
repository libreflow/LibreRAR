# AGENTS.md — LibreRAR

Règles de référence pour tout agent de code IA travaillant sur ce repo.

## Projet
Gestionnaire d'archives libre — Tauri 2 + React + TypeScript. Backend Rust :
`zip` (lecture/écriture), `unrar` (lecture RAR), `sevenz-rust` (lecture 7z).
UI en français.

## Commandes
- `npm run dev` — dev (Vite + Tauri)
- `npm run build` — `tsc && vite build`
- `npm run lint` — eslint
- `npm run test` — vitest run (frontend)
- `cd src-tauri && cargo test` — tests backend (zip-slip, round-trip)
- `npm run format` — prettier --write .
- Release : `npm run tauri build` (ne pas déclencher sans accord explicite)

## Règles Tauri 2 (non négociables)
- Toute commande IPC Rust est `async fn` et déclarée dans `generate_handler!`.
- Les chemins provenant du frontend (sources, destinations, entrées) sont
  validés côté Rust : refus de `..`, de chemins absolus et de préfixes Windows
  (voir `safe_join` dans `src-tauri/src/lib.rs`).
- Capabilities au moindre privilège : pas d'élargissement de permissions ni de
  wildcard sans justification dans la PR.
- Ne pas modifier `tauri.conf.json` sans accord explicite du mainteneur.
- Plugins officiels privilégiés (dialog, opener, log) plutôt que du custom.

## Sécurité
- Jamais de secret ni de clé d'API dans le code front ou le back.
- Toute nouvelle dépendance (npm ou crate) doit être auditée avant ajout
  (commits récents, maintenance, alertes sécurité).

## Workflow
- Une tâche = une issue = une petite PR focalisée.
- Spécification courte (contexte + critères d'acceptation) écrite avant de coder.
- CI verte obligatoire avant tout merge ; `npm run tauri dev` manuel requis
  avant toute release.
