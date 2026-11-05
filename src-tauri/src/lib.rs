use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use zip::{result::ZipError, write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

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
        let path = entry.name().replace('\\', "/");
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
        let name = header.name().replace('\\', "/");
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
    Ok(OperationResult { files, bytes })
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
            None => return Ok(OperationResult { files, bytes }),
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
    let mut result = OperationResult { files: 0, bytes: 0 };
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
    let result = match detect_format(path)? {
        "zip" => extract_zip(&ctx, path, dest_dir, password, selection, &mut written),
        "rar" => extract_rar(&ctx, path, dest_dir, password, selection, &mut written),
        _ => extract_sevenz(&ctx, path, dest_dir, password, selection, &mut written),
    };
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

/// Compte les fichiers (récursivement) que vont produire les sources.
fn count_sources(sources: &[PathBuf]) -> u64 {
    fn count_dir(dir: &Path) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .filter_map(Result::ok)
            .map(|entry| {
                let path = entry.path();
                if path.is_dir() {
                    count_dir(&path)
                } else {
                    1
                }
            })
            .sum()
    }
    sources
        .iter()
        .map(|source| {
            if source.is_dir() {
                count_dir(source)
            } else {
                1
            }
        })
        .sum()
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

fn add_file_to_zip<W: Write + io::Seek>(
    ctx: &OpContext,
    total: u64,
    zip: &mut ZipWriter<W>,
    name: &str,
    path: &Path,
    options: SimpleFileOptions,
    result: &mut OperationResult,
) -> CommandResult<()> {
    ctx.check()?;
    let mut file = File::open(path).map_err(CommandError::failed)?;
    // Copie par morceaux : un gros fichier ne doit pas être chargé en
    // mémoire intégralement.
    zip.start_file(name, options).map_err(|e| map_zip_err(e, name))?;
    let mut buffer = vec![0u8; 128 * 1024];
    let mut written: u64 = 0;
    loop {
        let read = file.read(&mut buffer).map_err(CommandError::failed)?;
        if read == 0 {
            break;
        }
        zip.write_all(&buffer[..read]).map_err(CommandError::failed)?;
        written += read as u64;
    }
    result.files += 1;
    result.bytes += written;
    ctx.progress(result.files, total, name);
    Ok(())
}

fn add_dir_to_zip<W: Write + io::Seek>(
    ctx: &OpContext,
    total: u64,
    zip: &mut ZipWriter<W>,
    prefix: &str,
    dir: &Path,
    options: SimpleFileOptions,
    result: &mut OperationResult,
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
            add_dir_to_zip(ctx, total, zip, &format!("{zip_name}/"), &path, options, result)?;
        } else {
            add_file_to_zip(ctx, total, zip, &zip_name, &path, options, result)?;
        }
    }
    Ok(())
}

fn map_zip_err(error: ZipError, name: &str) -> CommandError {
    match error {
        ZipError::UnsupportedArchive(reason) => {
            CommandError::failed(format!("Entrée non supportée ({reason}) : {name}"))
        }
        other => CommandError::failed(format!("{other} — {name}")),
    }
}

/// Écrit toutes les sources dans le writer ZIP.
fn write_sources<W: Write + io::Seek>(
    ctx: &OpContext,
    total: u64,
    zip: &mut ZipWriter<W>,
    sources: &[PathBuf],
    options: SimpleFileOptions,
    result: &mut OperationResult,
) -> CommandResult<()> {
    for source in sources {
        let source = source.as_path();
        let name = source
            .file_name()
            .ok_or_else(|| {
                CommandError::failed(format!("Chemin source invalide : {}", source.display()))
            })?
            .to_string_lossy()
            .to_string();
        if source.is_dir() {
            zip.add_directory(&name, options).map_err(CommandError::failed)?;
            add_dir_to_zip(ctx, total, zip, &format!("{name}/"), source, options, result)?;
        } else {
            add_file_to_zip(ctx, total, zip, &name, source, options, result)?;
        }
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
) -> CommandResult<OperationResult> {
    let registry = registry.inner().clone();
    registry.begin(&id);
    // La compression est bloquante (IO) : exécutée hors du runtime async.
    let task_registry = registry.clone();
    let task_id = id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        let dest = PathBuf::from(&dest);
        let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
        create_zip_inner(Some(&app), Some(&task_registry), &task_id, &dest, &sources)
    });
    let result = task.await.map_err(CommandError::failed);
    registry.end(&id);
    result?
}

fn create_zip_inner(
    app: Option<&AppHandle>,
    registry: Option<&OperationRegistry>,
    id: &str,
    dest: &Path,
    sources: &[PathBuf],
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
    let total = count_sources(sources);
    let mut result = OperationResult { files: 0, bytes: 0 };
    let file = File::create(dest).map_err(CommandError::failed)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // `finish` consomme le writer : la chaîne ci-dessous garantit sa
    // destruction (donc la fermeture du fichier) avant le nettoyage.
    let outcome = write_sources(&ctx, total, &mut zip, sources, options, &mut result)
        .and_then(|_| zip.finish().map_err(CommandError::failed));
    if let Err(error) = outcome {
        // Ne laisse pas d'archive partielle sur disque.
        let _ = fs::remove_file(dest);
        return Err(error);
    }
    Ok(result)
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
    fn roundtrip_zip() {
        let root = temp_root("zip");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("sous-dossier/b.txt"), "contenu B");
        let archive = root.join("test.zip");

        let created = create_zip_inner(None, None, "", &archive, &[source_dir.clone()]).unwrap();
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

        let error = create_zip_inner(None, None, "", &dest, &[source_dir.clone()]).unwrap_err();
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
        create_zip_inner(None, None, "", &archive, &[source_dir]).unwrap();

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
            create_zip_inner(None, Some(&registry), "op-2", &archive, &[source_dir]).unwrap_err();
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
}
