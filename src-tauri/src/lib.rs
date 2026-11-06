use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use zip::{
    result::ZipError, write::SimpleFileOptions, AesMode, CompressionMethod, ZipArchive, ZipWriter,
};

/// Options d'écriture d'une entrée ZIP. Le paramètre de durée de vie porte
/// l'emprunt du mot de passe AES (`with_aes_encryption` emprunte la
/// chaîne) ; sans mot de passe, l'alias dégénère en `SimpleFileOptions`.
type EntryOptions<'p> = zip::write::FileOptions<'p, 'static, ()>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub files: u64,
    pub bytes: u64,
    /// Durée de l'opération (annulation et nettoyage exclus).
    pub elapsed_ms: u64,
}

/// Erreur d'une commande IPC, sérialisée vers le frontend sous la forme
/// `{ kind, message }`. `kind` permet à l'UI de distinguer un mot de passe
/// manquant ou une annulation d'un échec générique.
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum CommandError {
    Cancelled {
        message: String,
    },
    PasswordRequired {
        message: String,
    },
    Failed {
        message: String,
    },
}

const OP_CANCELLED: &str = "Opération annulée.";
const OP_PASSWORD: &str = "Mot de passe requis ou incorrect.";

impl CommandError {
    fn cancelled() -> Self {
        Self::Cancelled {
            message: OP_CANCELLED.into(),
        }
    }

    fn password_required() -> Self {
        Self::PasswordRequired {
            message: OP_PASSWORD.into(),
        }
    }

    fn failed<E: std::fmt::Display>(e: E) -> Self {
        Self::Failed {
            message: e.to_string(),
        }
    }
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::Cancelled { message }
            | Self::PasswordRequired { message }
            | Self::Failed { message } => message,
        };
        f.write_str(message)
    }
}

/// Traduit une erreur du crate `zip` (mot de passe incorrect = typé).
fn zip_err(error: ZipError) -> CommandError {
    match error {
        ZipError::InvalidPassword => CommandError::password_required(),
        other => CommandError::failed(other),
    }
}

/// Traduit une erreur du crate `unrar` (codes ERAR_MISSING_PASSWORD et
/// ERAR_BAD_PASSWORD = mot de passe requis/incorrect).
fn rar_err(error: unrar::error::UnrarError) -> CommandError {
    use unrar::error::Code;
    match error.code {
        Code::MissingPassword | Code::BadPassword => CommandError::password_required(),
        _ => CommandError::failed(error),
    }
}

/// Traduit une erreur du crate `sevenz-rust` (chiffrage = mot de passe).
fn sevenz_err(error: sevenz_rust::Error) -> CommandError {
    match error {
        sevenz_rust::Error::PasswordRequired | sevenz_rust::Error::MaybeBadPassword(_) => {
            CommandError::password_required()
        }
        other => CommandError::failed(other),
    }
}

type CommandResult<T> = Result<T, CommandError>;

/// Progression d'une opération, émise vers le frontend (événement
/// `operation-progress`).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    id: String,
    done: u64,
    total: u64,
    current: String,
}

/// Opérations en cours : identifiants actifs (`running`) et demandes
/// d'annulation (`cancelled`). `end` retire le jeton, ce qui garantit
/// qu'aucun jeton orphelin ne subsiste après une annulation tardive.
#[derive(Default)]
struct OperationRegistry {
    running: Mutex<HashSet<String>>,
    cancelled: Mutex<HashSet<String>>,
}

impl OperationRegistry {
    fn begin(&self, id: &str) {
        self.running.lock().unwrap().insert(id.to_string());
    }

    fn end(&self, id: &str) {
        self.running.lock().unwrap().remove(id);
        self.cancelled.lock().unwrap().remove(id);
    }

    /// Demande l'annulation de l'opération `id` ; sans effet si elle n'est
    /// plus en cours (évite de laisser des jetons orphelins).
    fn cancel(&self, id: &str) {
        if self.running.lock().unwrap().contains(id) {
            self.cancelled.lock().unwrap().insert(id.to_string());
        }
    }

    fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled.lock().unwrap().contains(id)
    }
}

/// Contexte d'opération : vérifie l'annulation, émet la progression.
/// `app`/`registry` sont absents dans les tests unitaires (tout devient no-op).
struct OpContext<'a> {
    app: Option<&'a AppHandle>,
    registry: Option<&'a OperationRegistry>,
    id: &'a str,
}

impl OpContext<'_> {
    /// Erre si l'utilisateur a demandé l'annulation de l'opération.
    fn check(&self) -> CommandResult<()> {
        match self.registry {
            Some(registry) if registry.is_cancelled(self.id) => Err(CommandError::cancelled()),
            _ => Ok(()),
        }
    }

    fn progress(&self, done: u64, total: u64, current: &str) {
        if let Some(app) = self.app {
            let _ = app.emit(
                "operation-progress",
                ProgressPayload {
                    id: self.id.to_string(),
                    done,
                    total,
                    current: current.to_string(),
                },
            );
        }
    }
}

/// Fichiers écrits par une extraction : supprimés si l'opération échoue ou
/// est annulée, pour ne pas laisser de fichiers partiels (aligné sur
/// `create_zip` qui supprime l'archive partielle). Seuls les fichiers
/// nouvellement créés sont suivis — les fichiers préexistants ne sont jamais
/// supprimés.
#[derive(Default)]
struct ExtractedFiles {
    paths: Vec<PathBuf>,
}

impl ExtractedFiles {
    fn track(&mut self, path: &Path) {
        self.paths.push(path.to_path_buf());
    }

    fn clean(&self) {
        for path in &self.paths {
            let _ = fs::remove_file(path);
        }
    }
}

fn normalize_password(password: &Option<String>) -> Option<&str> {
    match password.as_deref() {
        Some(p) if !p.is_empty() => Some(p),
        _ => None,
    }
}

/// Une entrée fait partie de la sélection si :
/// - elle est désignée nom pour nom ;
/// - elle se trouve dans un dossier sélectionné (le contenu d'un dossier
///   sélectionné est extrait) — seules les sélections de dossier (slash
///   final, garanti par le listing) rattachent un contenu, sinon un
///   fichier « notes » sélectionné capterait « notes/a.txt » ;
/// - c'est un dossier dont la sélection contient un descendant (le dossier
///   parent est alors créé pour son contenu).
///
/// Chaque rattachement exige un séparateur `/` pour éviter les collisions
/// (`sources` vs `sources2/x`, `notes` vs `notes.txt`).
fn is_selected(name: &str, is_dir: bool, selection: &HashSet<String>) -> bool {
    if selection.contains(name) {
        return true;
    }
    for selected in selection {
        // Entrée située dans un dossier sélectionné.
        if selected.ends_with('/') {
            if let Some(rest) = name.strip_prefix(selected.trim_end_matches('/')) {
                if rest.is_empty() || rest.starts_with('/') {
                    return true;
                }
            }
        }
        // Dossier parent d'un élément sélectionné.
        if is_dir {
            let dir = name.trim_end_matches('/');
            if selected
                .strip_prefix(dir)
                .is_some_and(|rest| rest.starts_with('/'))
            {
                return true;
            }
        }
    }
    false
}

fn detect_format(path: &Path) -> CommandResult<&'static str> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("zip" | "jar") => Ok("zip"),
        Some("rar") => Ok("rar"),
        Some("7z") => Ok("sevenz"),
        _ => Err(CommandError::failed(
            "Format non pris en charge (formats acceptés : zip, rar, 7z)",
        )),
    }
}

/// Joint `root` et `entry_name` en refusant tout chemin qui s'échapperait
/// de `root` (protection « zip-slip » : `..`, chemins absolus, préfixes
/// Windows, noms vides et octets nuls).
fn safe_join(root: &Path, entry_name: &str) -> CommandResult<PathBuf> {
    if entry_name.contains('\0') {
        return Err(CommandError::failed(format!(
            "Chemin d'entrée invalide : {entry_name}"
        )));
    }
    let rel = Path::new(entry_name);
    // Au moins un composant normal : rejette les noms vides ou composés
    // uniquement de séparateurs/`./` (couvre l'entrée « . »).
    if !rel
        .components()
        .any(|c| matches!(c, Component::Normal(_)))
    {
        return Err(CommandError::failed(format!(
            "Chemin d'entrée invalide : {entry_name}"
        )));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(CommandError::failed(format!(
                    "Chemin d'entrée dangereux (..) : {entry_name}"
                )))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(CommandError::failed(format!(
                    "Chemin d'entrée absolu refusé : {entry_name}"
                )))
            }
        }
    }
    Ok(root.join(rel))
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

/// Normalise le nom d'une entrée de dossier : slash final garanti. Le
/// listing, la sélection et l'affichage s'accordent ainsi sur une seule
/// forme, quel que soit le format (un dossier 7z ou ZIP peut être listé
/// sans slash final).
fn dir_entry_path(mut name: String) -> String {
    if !name.ends_with('/') {
        name.push('/');
    }
    name
}

fn list_zip(path: &Path) -> CommandResult<Vec<ArchiveEntry>> {
    let file = File::open(path).map_err(CommandError::failed)?;
    let mut archive = ZipArchive::new(file).map_err(zip_err)?;
    let mut entries = Vec::with_capacity(archive.len() as usize);
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(zip_err)?;
        let path = entry.name().map_err(zip_err)?.replace('\\', "/");
        let is_dir = entry.is_dir() || path.ends_with('/');
        entries.push(ArchiveEntry {
            path: if is_dir {
                dir_entry_path(path)
            } else {
                path
            },
            size: entry.size(),
            compressed_size: entry.compressed_size(),
            is_dir,
        });
    }
    Ok(entries)
}

fn list_rar(path: &Path, password: Option<&str>) -> CommandResult<Vec<ArchiveEntry>> {
    let archive = match password {
        Some(password) => unrar::Archive::with_password(path, password),
        None => unrar::Archive::new(path),
    };
    let mut open = archive.open_for_listing().map_err(rar_err)?;
    let mut entries = Vec::new();
    loop {
        let before_file = match open.read_header().map_err(rar_err)? {
            Some(next) => next,
            None => return Ok(entries),
        };
        let header = before_file.entry();
        let name = header.filename.to_string_lossy().replace('\\', "/");
        let is_dir = header.is_directory() || name.ends_with('/');
        entries.push(ArchiveEntry {
            path: if is_dir && !name.ends_with('/') {
                format!("{name}/")
            } else {
                name
            },
            size: header.unpacked_size,
            // Le crate unrar n'expose pas la taille compressée.
            compressed_size: 0,
            is_dir,
        });
        open = before_file.skip().map_err(rar_err)?;
    }
}

fn list_sevenz(path: &Path, password: Option<&str>) -> CommandResult<Vec<ArchiveEntry>> {
    let password = match password {
        Some(p) => sevenz_rust::Password::from(p),
        None => sevenz_rust::Password::empty(),
    };
    let reader = sevenz_rust::SevenZReader::open(path, password).map_err(sevenz_err)?;
    let archive = reader.archive();
    Ok(archive
        .files
        .iter()
        .map(|entry| {
            let path = entry.name.replace('\\', "/");
            ArchiveEntry {
                path: if entry.is_directory {
                    dir_entry_path(path)
                } else {
                    path
                },
                size: entry.size,
                compressed_size: entry.compressed_size,
                is_dir: entry.is_directory,
            }
        })
        .collect())
}

#[tauri::command]
async fn list_archive(
    path: String,
    password: Option<String>,
) -> CommandResult<Vec<ArchiveEntry>> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let password = normalize_password(&password);
        list_archive_inner(&path, password)
    })
    .await
    .map_err(CommandError::failed)?
}

fn list_archive_inner(
    path: &Path,
    password: Option<&str>,
) -> CommandResult<Vec<ArchiveEntry>> {
    if !path.is_file() {
        return Err(CommandError::failed(format!(
            "Fichier introuvable : {}",
            path.display()
        )));
    }
    match detect_format(path)? {
        "zip" => list_zip(path),
        "rar" => list_rar(path, password),
        _ => list_sevenz(path, password),
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

fn extract_zip(
    ctx: &OpContext,
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
    written: &mut ExtractedFiles,
) -> CommandResult<OperationResult> {
    let file = File::open(path).map_err(CommandError::failed)?;
    let mut archive = ZipArchive::new(file).map_err(zip_err)?;
    let total = archive.len() as u64;
    let mut files = 0;
    let mut bytes = 0;
    let mut done = 0;
    for index in 0..archive.len() {
        ctx.check()?;
        // by_index_raw permet d'inspecter l'entrée avant décompression.
        let header = archive.by_index_raw(index).map_err(zip_err)?;
        let name = header.name().map_err(zip_err)?.replace('\\', "/");
        let is_dir = header.is_dir() || name.ends_with('/');
        let size = header.size();
        let encrypted = header.encrypted();
        drop(header);

        done += 1;
        ctx.progress(done, total, &name);

        if let Some(selection) = selection {
            if !is_selected(&name, is_dir, selection) {
                continue;
            }
        }
        let dest = safe_join(dest_dir, &name)?;
        if is_dir {
            fs::create_dir_all(&dest).map_err(CommandError::failed)?;
            continue;
        }
        let mut entry = if encrypted {
            let password = password.ok_or_else(|| CommandError::PasswordRequired {
                message: format!("Mot de passe requis pour l'entrée chiffrée : {name}"),
            })?;
            archive
                .by_index_decrypt(index, password.as_bytes())
                .map_err(zip_err)?
        } else {
            archive.by_index(index).map_err(zip_err)?
        };
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(CommandError::failed)?;
        }
        let preexisting = dest.exists();
        let mut out = File::create(&dest).map_err(CommandError::failed)?;
        io::copy(&mut entry, &mut out).map_err(CommandError::failed)?;
        if !preexisting {
            written.track(&dest);
        }
        files += 1;
        bytes += size;
    }
    Ok(OperationResult { files, bytes, elapsed_ms: 0 })
}

fn extract_rar(
    ctx: &OpContext,
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
    written: &mut ExtractedFiles,
) -> CommandResult<OperationResult> {
    // Compte d'abord les entrées pour avoir un total de progression.
    let total = list_rar(path, password)?.len() as u64;
    let archive = match password {
        Some(password) => unrar::Archive::with_password(path, password),
        None => unrar::Archive::new(path),
    };
    let mut open = archive.open_for_processing().map_err(rar_err)?;
    let mut files = 0;
    let mut bytes = 0;
    let mut done = 0;
    loop {
        ctx.check()?;
        let before_file = match open.read_header().map_err(rar_err)? {
            Some(next) => next,
            None => return Ok(OperationResult { files, bytes, elapsed_ms: 0 }),
        };
        let header = before_file.entry();
        let name = header.filename.to_string_lossy().replace('\\', "/");
        // Cohérent avec list_rar : certains dossiers ne sont signalés que
        // par le slash final.
        let is_dir = header.is_directory() || name.ends_with('/');
        let size = header.unpacked_size;
        done += 1;
        ctx.progress(done, total, &name);

        let selected = match selection {
            None => true,
            Some(selection) => is_selected(&name, is_dir, selection),
        };
        if !selected {
            open = before_file.skip().map_err(rar_err)?;
            continue;
        }
        // Le chemin de sortie passe par safe_join : les noms d'entrées RAR
        // sont validés comme ceux des ZIP et 7z (protection zip-slip).
        let dest = safe_join(dest_dir, &name)?;
        if is_dir {
            fs::create_dir_all(&dest).map_err(CommandError::failed)?;
            open = before_file.skip().map_err(rar_err)?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(CommandError::failed)?;
        }
        let preexisting = dest.exists();
        open = before_file.extract_to(&dest).map_err(rar_err)?;
        if !preexisting {
            written.track(&dest);
        }
        files += 1;
        bytes += size;
    }
}

fn extract_sevenz(
    ctx: &OpContext,
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
    written: &mut ExtractedFiles,
) -> CommandResult<OperationResult> {
    let password = match password {
        Some(p) => sevenz_rust::Password::from(p),
        None => sevenz_rust::Password::empty(),
    };
    let mut reader = sevenz_rust::SevenZReader::open(path, password).map_err(sevenz_err)?;
    let total = reader.archive().files.len() as u64;
    let mut result = OperationResult { files: 0, bytes: 0, elapsed_ms: 0 };
    let mut failure: Option<CommandError> = None;
    let mut done = 0;
    reader
        .for_each_entries(|entry, entry_reader| {
            let mut step = |result: &mut OperationResult,
                        written: &mut ExtractedFiles,
                        entry: &sevenz_rust::SevenZArchiveEntry,
                        entry_reader: &mut dyn Read|
             -> CommandResult<()> {
                ctx.check()?;
                done += 1;
                ctx.progress(done, total, &entry.name);
                let name = entry.name.replace('\\', "/");
                if entry.is_directory() {
                    return Ok(());
                }
                let selected = match selection {
                    None => true,
                    Some(selection) => is_selected(&name, false, selection),
                };
                if !selected {
                    // Il faut tout de même consommer le flux (archives solides).
                    io::copy(entry_reader, &mut io::sink()).map_err(CommandError::failed)?;
                    return Ok(());
                }
                let dest = safe_join(dest_dir, &name)?;
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(CommandError::failed)?;
                }
                let preexisting = dest.exists();
                let mut out = File::create(&dest).map_err(CommandError::failed)?;
                io::copy(entry_reader, &mut out).map_err(CommandError::failed)?;
                if !preexisting {
                    written.track(&dest);
                }
                result.files += 1;
                result.bytes += entry.size;
                Ok(())
            };
            match step(&mut result, written, entry, entry_reader) {
                Ok(()) => Ok(true),
                Err(error) => {
                    failure = Some(error);
                    Ok(false) // arrête le parcours des entrées
                }
            }
        })
        .map_err(sevenz_err)?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(result)
}

#[tauri::command]
async fn extract_archive(
    app: AppHandle,
    registry: tauri::State<'_, Arc<OperationRegistry>>,
    id: String,
    path: String,
    dest_dir: String,
    password: Option<String>,
    entries: Option<Vec<String>>,
) -> CommandResult<OperationResult> {
    let registry = registry.inner().clone();
    registry.begin(&id);
    // L'extraction est bloquante (IO) : exécutée hors du runtime async.
    let task_registry = registry.clone();
    let task_id = id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let path = PathBuf::from(path);
        let dest_dir = PathBuf::from(dest_dir);
        let password = normalize_password(&password);
        let selection: Option<HashSet<String>> =
            entries.map(|entries| entries.into_iter().collect());
        extract_archive_inner(
            Some(&app),
            Some(&task_registry),
            &task_id,
            &path,
            &dest_dir,
            password,
            selection.as_ref(),
        )
    });
    let result = task.await.map_err(CommandError::failed);
    registry.end(&id);
    result?
}

fn extract_archive_inner(
    app: Option<&AppHandle>,
    registry: Option<&OperationRegistry>,
    id: &str,
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
) -> CommandResult<OperationResult> {
    if !path.is_file() {
        return Err(CommandError::failed(format!(
            "Fichier introuvable : {}",
            path.display()
        )));
    }
    if !dest_dir.is_dir() {
        return Err(CommandError::failed(format!(
            "Dossier de destination introuvable : {}",
            dest_dir.display()
        )));
    }
    let ctx = OpContext {
        app,
        registry,
        id,
    };
    let mut written = ExtractedFiles::default();
    let start = std::time::Instant::now();
    let mut result = match detect_format(path)? {
        "zip" => extract_zip(&ctx, path, dest_dir, password, selection, &mut written),
        "rar" => extract_rar(&ctx, path, dest_dir, password, selection, &mut written),
        _ => extract_sevenz(&ctx, path, dest_dir, password, selection, &mut written),
    };
    if let Ok(result) = &mut result {
        result.elapsed_ms = start.elapsed().as_millis() as u64;
    }
    // Échec ou annulation : ne laisse aucun fichier partiel.
    if result.is_err() {
        written.clean();
    }
    result
}

/// Demande l'annulation de l'opération identifiée par `id`.
#[tauri::command]
async fn cancel_operation(
    registry: tauri::State<'_, Arc<OperationRegistry>>,
    id: String,
) -> CommandResult<()> {
    registry.cancel(&id);
    Ok(())
}

// ---------------------------------------------------------------------------
// Création d'archives ZIP
// ---------------------------------------------------------------------------

/// Taille au-delà de laquelle un fichier est compressé en flux séquentiel
/// plutôt que dans le pool : le pool tamponne chaque entrée compressée en
/// mémoire, ce seuil borne donc la mémoire consommée (workers + files
/// d'attente).
const PARALLEL_MAX_FILE_SIZE: u64 = 64 * 1024 * 1024;

/// Nombre de threads de compression. Au-delà de quelques cœurs le disque
/// devient le facteur limitant.
fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(8)
}

/// Message d'un worker : fichier prêt à être ajouté, ou erreur.
enum CompressedFile {
    Prepared {
        name: String,
        bytes: u64,
        file: zip::write::PreparedZipFile,
    },
    Failed(CommandError),
}

/// Compresse un fichier hors ligne dans un `ZipFileBuilder` : le CRC et les
/// tailles sont calculés au passage, l'entrée peut ensuite être ajoutée
/// telle quelle à l'archive.
fn compress_one(
    ctx: &OpContext,
    stop: &AtomicBool,
    name: &str,
    path: &Path,
    options: EntryOptions<'_>,
) -> CommandResult<(u64, zip::write::PreparedZipFile)> {
    ctx.check()?;
    let mut file = File::open(path).map_err(CommandError::failed)?;
    let mut builder = zip::write::ZipFileBuilder::new(name, options)
        .map_err(|e| map_zip_err(e, name))?;
    let mut buffer = vec![0u8; 128 * 1024];
    let mut bytes = 0u64;
    loop {
        if stop.load(Ordering::Relaxed) {
            return Err(CommandError::cancelled());
        }
        let read = file.read(&mut buffer).map_err(CommandError::failed)?;
        if read == 0 {
            break;
        }
        builder
            .write_all(&buffer[..read])
            .map_err(CommandError::failed)?;
        bytes += read as u64;
    }
    let prepared = builder.finish().map_err(|e| map_zip_err(e, name))?;
    Ok((bytes, prepared))
}

/// Worker du pool : pioche le fichier suivant, le compresse, envoie le
/// résultat au rédacteur. S'arrête dès qu'une erreur ou une annulation est
/// signalée (`stop`), ou quand le rédacteur a quitté (canal fermé).
fn compress_worker(
    ctx: &OpContext,
    files: &[(String, PathBuf)],
    next: &AtomicUsize,
    stop: &AtomicBool,
    options: EntryOptions<'_>,
    tx: mpsc::SyncSender<CompressedFile>,
) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        let index = next.fetch_add(1, Ordering::Relaxed);
        let Some((name, path)) = files.get(index) else {
            return; // plus rien à compresser
        };
        match compress_one(ctx, stop, name, path, options) {
            Ok((bytes, prepared)) => {
                if tx
                    .send(CompressedFile::Prepared {
                        name: name.clone(),
                        bytes,
                        file: prepared,
                    })
                    .is_err()
                {
                    return; // rédacteur parti (erreur ou annulation)
                }
            }
            Err(error) => {
                stop.store(true, Ordering::Relaxed);
                let _ = tx.send(CompressedFile::Failed(error));
                return;
            }
        }
    }
}

/// Vrai si la destination de l'archive se trouve dans un dossier source :
/// l'archive s'inclurait partiellement elle-même.
fn dest_inside_sources(dest: &Path, sources: &[PathBuf]) -> bool {
    let Some(file_name) = dest.file_name() else {
        return false;
    };
    let Some(parent) = dest.parent() else {
        return false;
    };
    let Ok(parent) = parent.canonicalize() else {
        return false;
    };
    let dest_abs = parent.join(file_name);
    sources.iter().any(|source| {
        source
            .canonicalize()
            .is_ok_and(|source| dest_abs.starts_with(source))
    })
}

fn map_zip_err(error: ZipError, name: &str) -> CommandError {
    match error {
        ZipError::UnsupportedArchive(reason) => {
            CommandError::failed(format!("Entrée non supportée ({reason}) : {name}"))
        }
        other => CommandError::failed(format!("{other} — {name}")),
    }
}

/// Parcourt les sources : ajoute les entrées de dossier à l'archive (dans
/// l'ordre du parcours) et collecte les fichiers à compresser.
fn collect_zip_plan<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    options: EntryOptions<'_>,
    sources: &[PathBuf],
) -> CommandResult<Vec<(String, PathBuf)>> {
    fn walk_dir<W: Write + io::Seek>(
        zip: &mut ZipWriter<W>,
        options: EntryOptions<'_>,
        prefix: &str,
        dir: &Path,
        files: &mut Vec<(String, PathBuf)>,
    ) -> CommandResult<()> {
        let entries = fs::read_dir(dir).map_err(CommandError::failed)?;
        for entry in entries {
            let entry = entry.map_err(CommandError::failed)?;
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            let zip_name = format!("{prefix}{name}");
            if path.is_dir() {
                zip.add_directory(&zip_name, options)
                    .map_err(|e| map_zip_err(e, &zip_name))?;
                walk_dir(zip, options, &format!("{zip_name}/"), &path, files)?;
            } else {
                files.push((zip_name, path));
            }
        }
        Ok(())
    }

    let mut files = Vec::new();
    for source in sources {
        let name = source
            .file_name()
            .ok_or_else(|| {
                CommandError::failed(format!("Chemin source invalide : {}", source.display()))
            })?
            .to_string_lossy()
            .to_string();
        if source.is_dir() {
            zip.add_directory(&name, options)
                .map_err(CommandError::failed)?;
            walk_dir(zip, options, &format!("{name}/"), source, &mut files)?;
        } else {
            files.push((name, source.clone()));
        }
    }
    Ok(files)
}

/// Compresse et écrit les fichiers dans l'archive. `small` passe par le
/// pool de threads (le rédacteur écrit les entrées au fur et à mesure de
/// leur achèvement) ; `big` — gros fichiers — est compressé en flux,
/// séquentiellement, pour borner la mémoire.
fn compress_and_append<W: Write + io::Seek>(
    ctx: &OpContext,
    zip: &mut ZipWriter<W>,
    small: &[(String, PathBuf)],
    big: &[(String, PathBuf)],
    options: EntryOptions<'_>,
    result: &mut OperationResult,
) -> CommandResult<()> {
    let total = (small.len() + big.len()) as u64;
    let workers = worker_count();
    let next = AtomicUsize::new(0);
    let stop = AtomicBool::new(false);

    let outcome = thread::scope(|scope| -> CommandResult<()> {
        let (tx, rx) = mpsc::sync_channel::<CompressedFile>(2);
        for _ in 0..workers {
            let tx = tx.clone();
            scope.spawn(|| compress_worker(ctx, small, &next, &stop, options, tx));
        }
        drop(tx);

        let mut failure: Option<CommandError> = None;
        let mut committed = 0;
        while failure.is_none() && committed < small.len() {
            // Annulation : on informe les workers et on s'arrête vite ;
            // `drop(rx)` réveille ceux qui attendraient dans `send`.
            if let Err(error) = ctx.check() {
                failure = Some(error);
                break;
            }
            match rx.recv() {
                Ok(CompressedFile::Prepared { name, bytes, file }) => {
                    if let Err(error) =
                        zip.add_prepared_file(file).map_err(|e| map_zip_err(e, &name))
                    {
                        failure = Some(error);
                        break;
                    }
                    result.files += 1;
                    result.bytes += bytes;
                    committed += 1;
                    ctx.progress(result.files, total, &name);
                }
                Ok(CompressedFile::Failed(error)) => {
                    failure = Some(error);
                }
                // Canal fermé avant la fin : n'arrive qu'après une erreur
                // (déjà consignée) ; on sort pour éviter un blocage.
                Err(_) => break,
            }
        }
        stop.store(true, Ordering::Relaxed);
        drop(rx);
        if let Some(error) = failure {
            return Err(error);
        }
        if committed != small.len() {
            return Err(CommandError::failed("Compression interrompue."));
        }
        Ok(())
    });
    outcome?;

    // Gros fichiers : compression en flux, séquentielle.
    for (name, path) in big {
        ctx.check()?;
        let mut file = File::open(path).map_err(CommandError::failed)?;
        zip.start_file(name, options)
            .map_err(|e| map_zip_err(e, name))?;
        let mut buffer = vec![0u8; 128 * 1024];
        let mut bytes = 0u64;
        loop {
            let read = file.read(&mut buffer).map_err(CommandError::failed)?;
            if read == 0 {
                break;
            }
            zip.write_all(&buffer[..read]).map_err(CommandError::failed)?;
            bytes += read as u64;
        }
        result.files += 1;
        result.bytes += bytes;
        ctx.progress(result.files, total, name);
    }
    Ok(())
}

#[tauri::command]
async fn create_zip(
    app: AppHandle,
    registry: tauri::State<'_, Arc<OperationRegistry>>,
    id: String,
    dest: String,
    sources: Vec<String>,
    password: Option<String>,
) -> CommandResult<OperationResult> {
    let registry = registry.inner().clone();
    registry.begin(&id);
    // La compression est bloquante (IO) : exécutée hors du runtime async.
    let task_registry = registry.clone();
    let task_id = id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest);
        let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
        let password = normalize_password(&password);
        create_zip_inner(
            Some(&app),
            Some(&task_registry),
            &task_id,
            &dest,
            &sources,
            password,
        )
    });
    let result = task.await.map_err(CommandError::failed);
    registry.end(&id);
    result?
}

#[allow(clippy::too_many_arguments)]
fn create_zip_inner(
    app: Option<&AppHandle>,
    registry: Option<&OperationRegistry>,
    id: &str,
    dest: &Path,
    sources: &[PathBuf],
    password: Option<&str>,
) -> CommandResult<OperationResult> {
    create_zip_with_limit(
        app,
        registry,
        id,
        dest,
        sources,
        password,
        PARALLEL_MAX_FILE_SIZE,
    )
}

/// `parallel_max_file` : taille limite des fichiers passés au pool ; les
/// fichiers plus gros sont compressés en flux (paramétrable pour les tests).
#[allow(clippy::too_many_arguments)]
fn create_zip_with_limit(
    app: Option<&AppHandle>,
    registry: Option<&OperationRegistry>,
    id: &str,
    dest: &Path,
    sources: &[PathBuf],
    password: Option<&str>,
    parallel_max_file: u64,
) -> CommandResult<OperationResult> {
    if sources.is_empty() {
        return Err(CommandError::failed("Aucun fichier source fourni."));
    }
    if dest.exists() {
        return Err(CommandError::failed(
            "Le fichier de destination existe déjà.",
        ));
    }
    if dest_inside_sources(dest, sources) {
        return Err(CommandError::failed(
            "La destination se trouve dans un dossier source : l'archive s'inclurait elle-même.",
        ));
    }
    let ctx = OpContext {
        app,
        registry,
        id,
    };
    let mut result = OperationResult { files: 0, bytes: 0, elapsed_ms: 0 };
    let start = std::time::Instant::now();
    let file = File::create(dest).map_err(CommandError::failed)?;
    let mut zip = ZipWriter::new(file);
    // AES-256 exclusivement (ZipCrypto, cassable, n'est jamais employé).
    let base = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let options: EntryOptions = match password {
        Some(password) => base.with_aes_encryption(AesMode::Aes256, password),
        None => base,
    };
    // Les dossiers sont écrits pendant le parcours ; les fichiers sont
    // répartis entre le pool parallèle et le flux séquentiel.
    let outcome = collect_zip_plan(&mut zip, options, sources).and_then(|files| {
        let mut small = Vec::new();
        let mut big = Vec::new();
        for (name, path) in files {
            // `ZipFileBuilder` (pool parallèle) refuse les options
            // chiffrées : une création protégée passe intégralement en
            // flux séquentiel via `start_file`.
            let is_big = password.is_some()
                || fs::metadata(&path).is_ok_and(|m| m.len() > parallel_max_file);
            if is_big {
                big.push((name, path));
            } else {
                small.push((name, path));
            }
        }
        compress_and_append(&ctx, &mut zip, &small, &big, options, &mut result)
    });
    // `finish` consomme le writer : la chaîne ci-dessous garantit sa
    // destruction (donc la fermeture du fichier) avant le nettoyage.
    let outcome = outcome.and_then(|_| zip.finish().map_err(CommandError::failed));
    if let Err(error) = outcome {
        // Ne laisse pas d'archive partielle sur disque.
        let _ = fs::remove_file(dest);
        return Err(error);
    }
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Création d'archives 7z
// ---------------------------------------------------------------------------

/// Parcourt les sources et collecte les entrées (dossiers inclus) avec leur
/// nom d'archive — préfixé par le nom de la source, même convention que les
/// ZIP créés.
fn collect_sevenz_plan(sources: &[PathBuf]) -> CommandResult<Vec<(String, PathBuf)>> {
    fn walk(prefix: &str, dir: &Path, plan: &mut Vec<(String, PathBuf)>) -> CommandResult<()> {
        let entries = fs::read_dir(dir).map_err(CommandError::failed)?;
        let mut children: Vec<(String, PathBuf)> = entries
            .filter_map(|entry| {
                entry.ok().map(|entry| {
                    let name = entry.file_name().to_string_lossy().to_string();
                    (format!("{prefix}{name}"), entry.path())
                })
            })
            .collect();
        // Ordre déterministe d'une exécution à l'autre.
        children.sort_by(|a, b| a.0.cmp(&b.0));
        for (name, path) in children {
            if path.is_dir() {
                plan.push((name.clone(), path.clone()));
                walk(&format!("{name}/"), &path, plan)?;
            } else {
                plan.push((name, path));
            }
        }
        Ok(())
    }

    let mut plan = Vec::new();
    for source in sources {
        let name = source
            .file_name()
            .ok_or_else(|| {
                CommandError::failed(format!("Chemin source invalide : {}", source.display()))
            })?
            .to_string_lossy()
            .to_string();
        plan.push((name.clone(), source.clone()));
        if source.is_dir() {
            walk(&format!("{name}/"), source, &mut plan)?;
        }
    }
    Ok(plan)
}

#[allow(clippy::too_many_arguments)]
fn create_sevenz_inner(
    app: Option<&AppHandle>,
    registry: Option<&OperationRegistry>,
    id: &str,
    dest: &Path,
    sources: &[PathBuf],
    password: Option<&str>,
) -> CommandResult<OperationResult> {
    if sources.is_empty() {
        return Err(CommandError::failed("Aucun fichier source fourni."));
    }
    if dest.exists() {
        return Err(CommandError::failed(
            "Le fichier de destination existe déjà.",
        ));
    }
    if dest_inside_sources(dest, sources) {
        return Err(CommandError::failed(
            "La destination se trouve dans un dossier source : l'archive s'inclurait elle-même.",
        ));
    }
    let ctx = OpContext {
        app,
        registry,
        id,
    };
    let plan = collect_sevenz_plan(sources)?;
    let total = plan.iter().filter(|(_, path)| !path.is_dir()).count() as u64;
    let mut result = OperationResult {
        files: 0,
        bytes: 0,
        elapsed_ms: 0,
    };
    let start = std::time::Instant::now();
    let file = File::create(dest).map_err(CommandError::failed)?;
    let mut writer = sevenz_rust::SevenZWriter::new(file).map_err(sevenz_err)?;
    let outcome = (|| -> CommandResult<()> {
        // Chiffrement optionnel : contenu AES-256 (LZMA2 derrière) et,
        // puisque AES figure dans les méthodes, en-tête également chiffré
        // (les noms de fichiers sont protégés).
        if let Some(password) = password {
            writer.set_content_methods(vec![
                sevenz_rust::AesEncoderOptions::new(sevenz_rust::Password::from(password))
                    .into(),
                sevenz_rust::SevenZMethod::LZMA2.into(),
            ]);
        }
        for (name, path) in &plan {
            ctx.check()?;
            let entry = sevenz_rust::SevenZArchiveEntry::from_path(path, name.clone());
            if path.is_dir() {
                writer
                    .push_archive_entry::<&[u8]>(entry, None)
                    .map_err(sevenz_err)?;
            } else {
                let file = File::open(path).map_err(CommandError::failed)?;
                writer
                    .push_archive_entry(entry, Some(file))
                    .map_err(sevenz_err)?;
                result.files += 1;
                result.bytes += fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                ctx.progress(result.files, total, name);
            }
        }
        Ok(())
    })();
    // `finish` consomme le writer : garanti exécuté (et le fichier fermé)
    // avant le nettoyage éventuel.
    let outcome = outcome.and_then(|_| {
        writer
            .finish()
            .map_err(|e| CommandError::failed(e.to_string()))
    });
    if let Err(error) = outcome {
        // Ne laisse pas d'archive partielle sur disque.
        let _ = fs::remove_file(dest);
        return Err(error);
    }
    result.elapsed_ms = start.elapsed().as_millis() as u64;
    Ok(result)
}

#[tauri::command]
async fn create_sevenz(
    app: AppHandle,
    registry: tauri::State<'_, Arc<OperationRegistry>>,
    id: String,
    dest: String,
    sources: Vec<String>,
    password: Option<String>,
) -> CommandResult<OperationResult> {
    let registry = registry.inner().clone();
    registry.begin(&id);
    // La compression est bloquante (IO) : exécutée hors du runtime async.
    let task_registry = registry.clone();
    let task_id = id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest);
        let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
        let password = normalize_password(&password);
        create_sevenz_inner(
            Some(&app),
            Some(&task_registry),
            &task_id,
            &dest,
            &sources,
            password,
        )
    });
    let result = task.await.map_err(CommandError::failed);
    registry.end(&id);
    result?
}

// ---------------------------------------------------------------------------
// Point d'entrée Tauri
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(Arc::new(OperationRegistry::default()))
        .invoke_handler(tauri::generate_handler![
            list_archive,
            extract_archive,
            create_zip,
            create_sevenz,
            cancel_operation
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de LibreRAR");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "librerar-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    /// Fabrique un ZIP avec les entrées données (nom, contenu ; `/` final =
    /// dossier).
    fn make_zip(path: &Path, entries: &[(&str, &str)]) {
        let file = File::create(path).unwrap();
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default();
        for (name, content) in entries {
            if name.ends_with('/') {
                zip.add_directory(name.trim_end_matches('/'), options).unwrap();
            } else {
                zip.start_file(*name, options).unwrap();
                zip.write_all(content.as_bytes()).unwrap();
            }
        }
        zip.finish().unwrap();
    }

    fn selection(paths: &[&str]) -> HashSet<String> {
        paths.iter().map(|p| p.to_string()).collect()
    }

    fn extract(
        archive: &Path,
        out: &Path,
        password: Option<&str>,
        selection: Option<&HashSet<String>>,
    ) -> CommandResult<OperationResult> {
        extract_archive_inner(None, None, "", archive, out, password, selection)
    }

    #[test]
    fn safe_join_refuse_la_traversee_de_chemin() {
        let root = Path::new("dest");
        assert!(safe_join(root, "../secret.txt").is_err());
        assert!(safe_join(root, "a/../../secret.txt").is_err());
        assert!(safe_join(root, "/absolu.txt").is_err());
        assert!(safe_join(root, "C:\\windows\\evil.txt").is_err());
        assert!(safe_join(root, "dossier/fichier.txt").is_ok());
        // Noms vides ou composés uniquement de points/`./` : refusés.
        assert!(safe_join(root, ".").is_err());
        assert!(safe_join(root, "./").is_err());
        assert!(safe_join(root, "\u{0}").is_err());
        assert!(safe_join(root, "./ok.txt").is_ok());
    }

    #[test]
    fn annulation_hors_operation_est_ignoree() {
        let registry = OperationRegistry::default();
        registry.cancel("op-x");
        assert!(!registry.is_cancelled("op-x"));

        registry.begin("op-1");
        registry.cancel("op-1");
        assert!(registry.is_cancelled("op-1"));
        registry.end("op-1");
        assert!(!registry.is_cancelled("op-1"));
    }

    #[test]
    fn creation_parallelise_roundtrip() {
        let root = temp_root("parallel");
        let source_dir = root.join("sources");
        for i in 0..50 {
            write(
                &source_dir.join(format!("sub/f{i}.txt")),
                &format!("contenu {i}"),
            );
        }
        let archive = root.join("test.zip");

        let created = create_zip_inner(None, None, "", &archive, &[source_dir.clone()], None).unwrap();
        assert_eq!(created.files, 50);
        // « contenu 0 »…« contenu 49 » : 10 fichiers de 9 octets + 40 de 10.
        assert_eq!(created.bytes, 10 * 9 + 40 * 10);

        let entries = list_archive_inner(&archive, None).unwrap();
        assert_eq!(
            entries.iter().filter(|e| !e.is_dir).count(),
            50,
            "chaque fichier doit apparaître dans le listing"
        );

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract(&archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 50);
        assert_eq!(
            fs::read_to_string(out.join("sources/sub/f49.txt")).unwrap(),
            "contenu 49"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn gros_fichiers_compresses_en_flux() {
        // Seuil abaissé à 1 octet : tous les fichiers passent par le
        // chemin séquentiel (streaming) — même résultat, même contenu.
        let root = temp_root("flux");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("b.txt"), "contenu B");
        let archive = root.join("test.zip");

        let created =
            create_zip_with_limit(None, None, "", &archive, &[source_dir.clone()], None, 1).unwrap();
        assert_eq!(created.files, 2);

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract(&archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read_to_string(out.join("sources/a.txt")).unwrap(),
            "contenu A"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn roundtrip_zip() {
        let root = temp_root("zip");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("sous-dossier/b.txt"), "contenu B");
        let archive = root.join("test.zip");

        let created = create_zip_inner(None, None, "", &archive, &[source_dir.clone()], None).unwrap();
        assert_eq!(created.files, 2);

        let entries = list_archive_inner(&archive, None).unwrap();
        let names: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
        assert!(names.contains(&"sources/a.txt".to_string()));
        assert!(names.contains(&"sources/sous-dossier/b.txt".to_string()));

        // Extraction complète
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract(&archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read_to_string(out.join("sources/a.txt")).unwrap(),
            "contenu A"
        );

        // Extraction sélective : seul b.txt est écrit
        let out2 = root.join("out2");
        fs::create_dir_all(&out2).unwrap();
        extract(&archive, &out2, None, Some(&selection(&["sources/sous-dossier/b.txt"]))).unwrap();
        assert!(out2.join("sources/sous-dossier/b.txt").is_file());
        assert!(!out2.join("sources/a.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn roundtrip_zip_chiffre_aes256() {
        let root = temp_root("zip-crypt");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu secret");
        write(&source_dir.join("sous/b.txt"), "contenu également secret");
        let archive = root.join("secret.zip");
        let password = "mot-de-passe-secret";

        let created =
            create_zip_inner(None, None, "", &archive, &[source_dir.clone()], Some(password))
                .unwrap();
        assert_eq!(created.files, 2);

        // Le listing (en-têtes seuls) reste possible sans mot de passe.
        let entries = list_archive_inner(&archive, None).unwrap();
        assert_eq!(entries.iter().filter(|e| !e.is_dir).count(), 2);
        // Les fichiers sont bien annoncés chiffrés (les entrées de
        // dossier n'embarquent aucune donnée et restent en clair).
        let file = File::open(&archive).unwrap();
        let mut zip = ZipArchive::new(file).unwrap();
        for index in 0..zip.len() {
            let header = zip.by_index_raw(index).unwrap();
            assert!(header.is_dir() || header.encrypted());
        }

        // Extraction sans mot de passe : échec typé.
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let error = extract(&archive, &out, None, None).unwrap_err();
        assert!(matches!(error, CommandError::PasswordRequired { .. }));
        assert!(!out.join("sources/a.txt").exists());

        // Extraction avec un mauvais mot de passe : échec typé.
        let error = extract(&archive, &out, Some("mauvais"), None).unwrap_err();
        assert!(matches!(error, CommandError::PasswordRequired { .. }));
        assert!(!out.join("sources/a.txt").exists());

        // Extraction avec le bon mot de passe : round-trip complet.
        let extracted = extract(&archive, &out, Some(password), None).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read_to_string(out.join("sources/a.txt")).unwrap(),
            "contenu secret"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn selection_dun_dossier_extrait_son_contenu_sans_collision() {
        let root = temp_root("sel");
        let archive = root.join("test.zip");
        make_zip(
            &archive,
            &[
                ("notes", "fichier nommé notes"),
                ("notes/a.txt", "contenu A"),
                ("d/", ""),
                ("d/x.txt", "contenu X"),
                ("d2/y.txt", "contenu Y"),
            ],
        );

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        // Sélection du dossier « d/ » et du fichier « notes/a.txt ».
        extract(&archive, &out, None, Some(&selection(&["d/", "notes/a.txt"]))).unwrap();

        assert!(out.join("d/x.txt").is_file());
        assert!(out.join("notes/a.txt").is_file());
        // Le fichier « notes » (collision de préfixe avec « notes/a.txt »)
        // n'a pas été extrait : « notes » est resté un dossier.
        assert!(out.join("notes").is_dir());
        assert!(!out.join("notes").is_file());
        // « d2 » n'a rien à voir avec « d ».
        assert!(!out.join("d2/y.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn extraction_echouee_ne_laisse_pas_de_fichiers_partiels() {
        let root = temp_root("partial");
        let archive = root.join("test.zip");
        // L'entrée « ../evil.txt » est refusée par safe_join après que
        // « a.txt » a déjà été écrite : le nettoyage doit l'effacer.
        make_zip(&archive, &[("a.txt", "contenu A"), ("../evil.txt", "malware")]);

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        assert!(extract(&archive, &out, None, None).is_err());
        assert!(!out.join("a.txt").exists());
        assert!(!out.join("evil.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creation_dans_un_dossier_source_est_refusee() {
        let root = temp_root("selfinc");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        let dest = source_dir.join("auto.zip");

        let error = create_zip_inner(None, None, "", &dest, &[source_dir.clone()], None).unwrap_err();
        assert!(error.to_string().contains("dossier source"));
        assert!(!dest.exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn selection_dun_fichier_ne_capte_pas_un_dossier_homonyme() {
        let root = temp_root("homonyme");
        let archive = root.join("test.zip");
        make_zip(
            &archive,
            &[
                ("notes", "fichier nommé notes"),
                ("notes/a.txt", "contenu A"),
                ("d/", ""),
                ("d/x.txt", "contenu X"),
            ],
        );

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        // Sélection du seul fichier « notes » : son homonyme dossier
        // (« notes/a.txt ») ne doit pas être extrait.
        extract(&archive, &out, None, Some(&selection(&["notes"]))).unwrap();
        assert!(out.join("notes").is_file());
        assert!(!out.join("notes/a.txt").exists());
        assert!(!out.join("d/x.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn roundtrip_sevenz() {
        let root = temp_root("7z");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("b.txt"), "contenu B");
        write(&source_dir.join("sous/c.txt"), "contenu C");
        let archive = root.join("test.7z");

        sevenz_rust::compress_to_path(&source_dir, &archive).unwrap();

        let entries = list_archive_inner(&archive, None).unwrap();
        assert!(entries.iter().any(|e| e.path == "a.txt"));
        // Les dossiers sont listés avec un slash final, quel que soit le format.
        if let Some(dir_entry) = entries.iter().find(|e| e.is_dir) {
            assert!(
                dir_entry.path.ends_with('/'),
                "dossier sans slash final : {}",
                dir_entry.path
            );
        }

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract(&archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 3);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn annulation_arrete_lextraction() {
        let root = temp_root("cancel");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("b.txt"), "contenu B");
        let archive = root.join("test.zip");
        create_zip_inner(None, None, "", &archive, &[source_dir], None).unwrap();

        let registry = OperationRegistry::default();
        registry.begin("op-1");
        registry.cancel("op-1");
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let error =
            extract_archive_inner(None, Some(&registry), "op-1", &archive, &out, None, None)
                .unwrap_err();
        assert!(matches!(error, CommandError::Cancelled { .. }));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn extraction_annulee_ne_laisse_rien() {
        let root = temp_root("cancel-clean");
        let archive = root.join("test.zip");
        make_zip(&archive, &[("a.txt", "contenu A"), ("b.txt", "contenu B")]);

        let registry = OperationRegistry::default();
        registry.begin("op-1");
        registry.cancel("op-1");
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        assert!(extract_archive_inner(None, Some(&registry), "op-1", &archive, &out, None, None).is_err());
        assert!(!out.join("a.txt").exists());
        assert!(!out.join("b.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creation_annulee_ne_laisse_pas_darchive_partielle() {
        let root = temp_root("cancel-create");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        let archive = root.join("partiel.zip");

        let registry = OperationRegistry::default();
        registry.begin("op-2");
        registry.cancel("op-2");
        let error =
            create_zip_inner(None, Some(&registry), "op-2", &archive, &[source_dir], None)
                .unwrap_err();
        assert!(matches!(error, CommandError::Cancelled { .. }));
        assert!(!archive.exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn roundtrip_sevenz_chiffre() {
        let root = temp_root("7z-crypt");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu secret");
        let archive = root.join("secret.7z");
        let password = "mot-de-passe";

        sevenz_rust::compress_to_path_encrypted(
            &source_dir,
            &archive,
            sevenz_rust::Password::from(password),
        )
        .unwrap();

        // Le listing accepte le mot de passe.
        let entries = list_archive_inner(&archive, Some(password)).unwrap();
        assert!(entries.iter().any(|e| e.path == "a.txt"));

        // Extraction : sans mot de passe ça échoue, avec le bon ça réussit.
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        assert!(extract(&archive, &out, None, None).is_err());

        let out2 = root.join("out2");
        fs::create_dir_all(&out2).unwrap();
        let extracted = extract(&archive, &out2, Some(password), None).unwrap();
        assert_eq!(extracted.files, 1);
        assert_eq!(
            fs::read_to_string(out2.join("a.txt")).unwrap(),
            "contenu secret"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creation_sevenz_roundtrip() {
        let root = temp_root("7z-create");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("sous/b.txt"), "contenu B");
        let archive = root.join("test.7z");

        let created =
            create_sevenz_inner(None, None, "", &archive, &[source_dir.clone()], None).unwrap();
        assert_eq!(created.files, 2);

        // Mêmes noms d'entrées que les ZIP créés (préfixe « sources/ »).
        let entries = list_archive_inner(&archive, None).unwrap();
        let names: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
        assert!(names.contains(&"sources/a.txt".to_string()));
        assert!(names.contains(&"sources/sous/b.txt".to_string()));

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract(&archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read_to_string(out.join("sources/a.txt")).unwrap(),
            "contenu A"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creation_sevenz_chiffree() {
        let root = temp_root("7z-create-crypt");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu secret");
        let archive = root.join("secret.7z");
        let password = "mot-de-passe-secret";

        create_sevenz_inner(
            None,
            None,
            "",
            &archive,
            &[source_dir.clone()],
            Some(password),
        )
        .unwrap();

        // L'en-tête est chiffré : le listing sans mot de passe échoue
        // avec l'erreur typée (différence avec le ZIP AES).
        let error = list_archive_inner(&archive, None)
            .err()
            .expect("le listing sans mot de passe doit échouer");
        assert!(matches!(error, CommandError::PasswordRequired { .. }));

        // Listing avec le bon mot de passe : réussit.
        let entries = list_archive_inner(&archive, Some(password)).unwrap();
        assert!(entries.iter().any(|e| e.path == "sources/a.txt"));

        // Extraction : sans mot de passe et mauvais mot de passe échouent.
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        assert!(matches!(
            extract(&archive, &out, None, None).unwrap_err(),
            CommandError::PasswordRequired { .. }
        ));
        assert!(matches!(
            extract(&archive, &out, Some("mauvais"), None).unwrap_err(),
            CommandError::PasswordRequired { .. }
        ));
        assert!(!out.join("sources/a.txt").exists());

        // Bon mot de passe : round-trip complet.
        let extracted = extract(&archive, &out, Some(password), None).unwrap();
        assert_eq!(extracted.files, 1);
        assert_eq!(
            fs::read_to_string(out.join("sources/a.txt")).unwrap(),
            "contenu secret"
        );

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creation_sevenz_annulee_ne_laisse_pas_darchive_partielle() {
        let root = temp_root("7z-create-cancel");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        let archive = root.join("partiel.7z");

        let registry = OperationRegistry::default();
        registry.begin("op-3");
        registry.cancel("op-3");
        let error = create_sevenz_inner(
            None,
            Some(&registry),
            "op-3",
            &archive,
            &[source_dir],
            None,
        )
        .unwrap_err();
        assert!(matches!(error, CommandError::Cancelled { .. }));
        assert!(!archive.exists());

        fs::remove_dir_all(&root).unwrap();
    }
}
