# ROADMAP LibreRAR — Objectif : dépasser WinRAR

> Principe directeur : **ne copier pas WinRAR, dépasse-le.** WinRAR porte
> 30 ans d'héritage (disquettes, CD, antivirus d'époque). Nous visons les
> besoins réels d'un utilisateur 2026 : sécurité, formats modernes,
> intégration système, sobriété.

## Critère de victoire

LibreRAR « bat WinRAR » quand un utilisateur qui migre ne perd **aucune
fonction qu'il utilise réellement en 2026** et gagne en plus : licence libre,
UI moderne, interface française, légèreté, sécurité IPC testée.

---

## Ce que nous ne ferons PAS (fonctions devenues inutiles en 2026)

| Fonction WinRAR                                    | Pourquoi abandonnée en 2026                                                                                               |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Auto-extractibles (SFX)**                        | Windows et macOS bloquent les .exe non signés ; l'extracteur ZIP/7z est natif partout ; vecteur d'attaque malware majeur. |
| **Enregistrement de réparation (recovery record)** | Conçu pour supports d'époque (disquette, CD rayé). Stockage moderne + redondance : usage marginal réel.                   |
| **Découpe à taille disquette/CD (héritage)**       | Découpe pertinente uniquement pour limites de taille (FAT32, uploads) → version moderne couverte en Phase 2.              |
| **Formats morts : ARJ, LZH, ACE, CAB, UUE**        | Aucune archive de ce type créée depuis 15 ans. ACE abandonné même par WinRAR (faille CVE-2019).                           |
| **Gestionnaire de fichiers intégré**               | L'explorateur natif suffit ; dupliquer un file manager = dette UI sans valeur.                                            |
| **Antivirus intégré à l'extraction**               | Windows Defender / XProtect fonctionnent en temps réel ; doublon.                                                         |
| **Benchmark de compression intégré**               | Gadget d'époque ; les crates (zlib-rs multithread) font déjà le travail.                                                  |
| **Commentaires intégrés dans l'archive**           | Métadonnée jamais lue ; aucun flux de travail moderne ne s'appuie dessus.                                                 |
| **Skins / multi-thèmes**                           | Focus : un seul thème au propre (déjà en place, rétro 8-bit).                                                             |

---

## Phase 1 — Combler l'écart fonctionnel critique (v0.9)

_Objectif : ne rien perdre en migrant depuis WinRAR._

| #   | Fonction                                     | Critères d'acceptation                                                                                     |
| --- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1.1 | **Mot de passe à la création ZIP** — ✅ fait | AES-256 obligatoire (jamais ZipCrypto, cassable) ; tests round-trip chiffré ; refus clear-text par défaut. |
| 1.2 | **Création 7z** (LZMA2) — ✅ fait            | Via `sevenz-rust` ; choix niveau de compression ; chiffrement AES-256 ; tests round-trip.                  |
| 1.3 | **Test d'intégrité** (`Test archive`) — ✅ fait | Commande IPC `test_archive` ; 100% des entrées vérifiées (CRC/hash), rapport clair en français.            |
| 1.4 | **Chiffrement fort à la lecture**            | ZIP AES + RAR + 7z AES-256 (✅ déjà présent — à couvrir de tests réels).                                   |
| 1.5 | **Vue « détails de compression »** — ✅ préexistante | Ratio, taille économisée par entrée (donnée déjà fournie par le listing).                                  |

## Phase 2 — Intégration système 2026 (v1.0)

_Objectif : présent là où l'utilisateur clique réellement._

| #   | Fonction                       | Critères d'acceptation                                                                                                                 |
| --- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1 | **Menu contextuel Windows 11** | « Extraire ici / Extraire vers… / Ouvrir avec LibreRAR » via le nouveau modèle de menu (packaged app / sparse), sans élévation.        |
| 2.2 | **Association d'extensions**   | .zip .7z .rar .jar ouvrables par double-clic ; deep links Tauri.                                                                       |
| 2.3 | **Découpe de volumes moderne** — ✅ fait (découpe générique `.001`) | Découpe en volumes paramétrables (taille libre), **recollement** à l'ouverture ; indispensable pour partages limités en taille. |
| 2.4 | **Auto-update silencieuse**    | Plugin Tauri updater signé ; notification non intrusive.                                                                               |
| 2.5 | **Distribution moderne**       | `winget install librerar` ; package MSIX optionnel ; (pas de release sans validation manuelle `npm run tauri dev`).                    |

## Phase 3 — Formats du monde réel 2026 (v1.1)

_Objectif : couvrir ce que l'utilisateur télécharge et partage aujourd'hui._

| #   | Fonction                                    | Critères d'acceptation                                                                                    |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 3.1 | **Lecture TAR / tar.gz / tar.xz / tar.zst** | Le format des devs (dépôts, npm, releases GitHub) ; crates `tar` + décodeurs stream.                      |
| 3.2 | **Création tar.gz / tar.zst**               | Zstandard : standard de fait 2026 (rapide, moderne).                                                      |
| 3.3 | **Aperçu avant extraction**                 | Ouvrir un fichier texte/image directement depuis l'archive, en lecture seule, sans extraction sur disque. |
| 3.4 | **Sommes de contrôle**                      | SHA-256/SHA-512 par entrée et sur archive ; export d'un `.sha256`.                                        |

## Phase 4 — L'avantage que WinRAR n'aura jamais (v1.2+)

_Objectif : transformer « libre » en « meilleur »._

| #   | Fonction                           | Critères d'acceptation                                                                         |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 4.1 | **Multiplateforme complet**        | Linux + macOS natifs (Tauri rend ceci quasi gratuit) ; WinRAR n'a que des ports mineurs.       |
| 4.2 | **Extraction parallèle multicœur** | Extraction simultanée de plusieurs entrées ; durée affichée (déjà en place côté création).     |
| 4.3 | **File d'opérations**              | Extraire/créer en arrière-plan, annulation propre, notification système à la fin.              |
| 4.4 | **Historique récent + favoris**    | Rappel des archives récemment ouvertes ; chemins favoris.                                      |
| 4.5 | **Audit sécurité continu**         | Fuzzing `safe_join`/extraction, CI durcie, budget CVE nul accepté sur les crates.              |
| 4.6 | **Accessibilité & i18n**           | Audit accessibilité complet + ouverture à d'autres langues (structure i18n), l'anglais inclus. |

---

## Cadre de travail (conforme AGENTS.md)

- **Une ligne = une issue = une PR focalisée** , spécification courte avant code.
- Toute nouvelle dépendance (npm/crate) audité avant ajout (Commits récents, CVE).
- CI verte + `cargo test` (zip-slip, round-trip) obligatoire avant merge de chaque PR.
- Pas d'élargissement des capabilities Tauri sans justification écrite.
- Jamais de modification de `tauri.conf.json` sans accord mainteneur.

## Ordre de bataille suggéré

```
Phase 1 (1.1 → 1.5)   ── ├ « V0.9 : parité utile »
Phase 2 (2.1 → 2.5)   ── ├ « V1.0 : parité système »
Phase 3 (3.1 → 3.4)   ── ├ « V1.1 : parité monde dev »
Phase 4                ── └ « V1.2 : différenciation libre »
```

> Victoire sur WinRAR = **fin de Phase 2** (l'utilisateur migre sans perte
> réelle). Phases 3–4 = victoire sur _tous_ les concurrents.
