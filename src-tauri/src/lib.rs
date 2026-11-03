use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
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

type CommandResult<T> = Result<T, String>;

const OP_CANCELLED: &str = "Opération annulée.";

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

/// Jetons d'annulation des opérations en cours.
#[derive(Default)]
struct CancelTokens(Mutex<HashSet<String>>);

/// Contexte d'opération : vérifie l'annulation, émet la progression.
/// `app`/`tokens` sont absents dans les tests unitaires (tout devient no-op).
struct OpContext<'a> {
    app: Option<&'a AppHandle>,
    tokens: Option<&'a CancelTokens>,
    id: &'a str,
}

impl OpContext<'_> {
    fn cancelled(&self) -> bool {
        match self.tokens {
            Some(tokens) => tokens.0.lock().unwrap().contains(self.id),
            None => false,
        }
    }

    /// Erre si l'utilisateur a demandé l'annulation de l'opération.
    fn check(&self) -> CommandResult<()> {
        if self.cancelled() {
            Err(OP_CANCELLED.into())
        } else {
            Ok(())
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

fn to_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn normalize_password(password: &Option<String>) -> Option<&str> {
    match password.as_deref() {
        Some(p) if !p.is_empty() => Some(p),
        _ => None,
    }
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
        _ => Err("Format non pris en charge (formats acceptés : zip, rar, 7z)".into()),
    }
}

/// Joint `root` et `entry_name` en refusant tout chemin qui s'échapperait
/// de `root` (protection « zip-slip » : `..`, chemins absolus, préfixes Windows).
fn safe_join(root: &Path, entry_name: &str) -> CommandResult<PathBuf> {
    let rel = Path::new(entry_name);
    if !rel.components().any(|c| matches!(c, Component::Normal(_) | Component::CurDir)) {
        // Couvre aussi les noms vides ou composés uniquement de séparateurs.
        return Err(format!("Chemin d'entrée invalide : {entry_name}"));
    }
    for component in rel.components() {
        match component {
            Component::Normal(_) | Component::CurDir => {}
            Component::ParentDir => {
                return Err(format!("Chemin d'entrée dangereux (..) : {entry_name}"))
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(format!("Chemin d'entrée absolu refusé : {entry_name}"))
            }
        }
    }
    Ok(root.join(rel))
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

fn list_zip(path: &Path) -> CommandResult<Vec<ArchiveEntry>> {
    let file = File::open(path).map_err(to_err)?;
    let mut archive = ZipArchive::new(file).map_err(to_err)?;
    let mut entries = Vec::with_capacity(archive.len() as usize);
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index).map_err(to_err)?;
        entries.push(ArchiveEntry {
            path: entry.name().replace('\\', "/"),
            size: entry.size(),
            compressed_size: entry.compressed_size(),
            is_dir: entry.is_dir(),
        });
    }
    Ok(entries)
}

fn list_rar(path: &Path, password: Option<&str>) -> CommandResult<Vec<ArchiveEntry>> {
    let archive = match password {
        Some(password) => unrar::Archive::with_password(path, password),
        None => unrar::Archive::new(path),
    };
    let mut open = archive.open_for_listing().map_err(to_err)?;
    let mut entries = Vec::new();
    loop {
        let before_file = match open.read_header().map_err(to_err)? {
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
            compressed_size: 0,
            is_dir,
        });
        open = before_file.skip().map_err(to_err)?;
    }
}

fn list_sevenz(path: &Path, password: Option<&str>) -> CommandResult<Vec<ArchiveEntry>> {
    let password = match password {
        Some(p) => sevenz_rust::Password::from(p),
        None => sevenz_rust::Password::empty(),
    };
    let reader = sevenz_rust::SevenZReader::open(path, password).map_err(to_err)?;
    let archive = reader.archive();
    Ok(archive
        .files
        .iter()
        .map(|entry| ArchiveEntry {
            path: entry.name.replace('\\', "/"),
            size: entry.size,
            compressed_size: entry.compressed_size,
            is_dir: entry.is_directory,
        })
        .collect())
}

#[tauri::command]
async fn list_archive(
    path: String,
    password: Option<String>,
) -> CommandResult<Vec<ArchiveEntry>> {
    let path = PathBuf::from(path);
    let password = normalize_password(&password);
    list_archive_inner(&path, password)
}

fn list_archive_inner(
    path: &Path,
    password: Option<&str>,
) -> CommandResult<Vec<ArchiveEntry>> {
    if !path.is_file() {
        return Err(format!("Fichier introuvable : {}", path.display()));
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
) -> CommandResult<OperationResult> {
    let file = File::open(path).map_err(to_err)?;
    let mut archive = ZipArchive::new(file).map_err(to_err)?;
    let total = archive.len() as u64;
    let mut files = 0;
    let mut bytes = 0;
    let mut done = 0;
    for index in 0..archive.len() {
        ctx.check()?;
        // by_index_raw permet d'inspecter l'entrée avant décompression.
        let header = archive.by_index_raw(index).map_err(to_err)?;
        let name = header.name().replace('\\', "/");
        let is_dir = header.is_dir();
        let size = header.size();
        let encrypted = header.encrypted();
        drop(header);

        done += 1;
        ctx.progress(done, total, &name);

        if let Some(selected) = selection {
            if !selected.contains(&name) {
                continue;
            }
        }
        let dest = safe_join(dest_dir, &name)?;
        if is_dir {
            fs::create_dir_all(&dest).map_err(to_err)?;
            continue;
        }
        let mut entry = if encrypted {
            let password = password.ok_or_else(|| {
                format!("Mot de passe requis pour l'entrée chiffrée : {name}")
            })?;
            archive
                .by_index_decrypt(index, password.as_bytes())
                .map_err(to_err)?
        } else {
            archive.by_index(index).map_err(to_err)?
        };
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(to_err)?;
        }
        let mut out = File::create(&dest).map_err(to_err)?;
        io::copy(&mut entry, &mut out).map_err(to_err)?;
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
) -> CommandResult<OperationResult> {
    // Compte d'abord les entrées pour avoir un total de progression.
    let total = list_rar(path, password)?.len() as u64;
    let archive = match password {
        Some(password) => unrar::Archive::with_password(path, password),
        None => unrar::Archive::new(path),
    };
    let mut open = archive.open_for_processing().map_err(to_err)?;
    let mut files = 0;
    let mut bytes = 0;
    let mut done = 0;
    loop {
        ctx.check()?;
        let before_file = match open.read_header().map_err(to_err)? {
            Some(next) => next,
            None => return Ok(OperationResult { files, bytes }),
        };
        let header = before_file.entry();
        let name = header.filename.to_string_lossy().replace('\\', "/");
        let is_dir = header.is_directory();
        let size = header.unpacked_size;
        done += 1;
        ctx.progress(done, total, &name);

        let wanted = is_dir
            || match selection {
                None => true,
                // Une sélection sur un dossier implique son contenu.
                Some(selected) => {
                    selected.contains(&name)
                        || selected.iter().any(|entry| entry.starts_with(&name))
                }
            };
        if wanted {
            if is_dir {
                let dest = safe_join(dest_dir, &name)?;
                fs::create_dir_all(&dest).map_err(to_err)?;
                open = before_file.skip().map_err(to_err)?;
                continue;
            }
            open = before_file.extract_with_base(dest_dir).map_err(to_err)?;
            files += 1;
            bytes += size;
        } else {
            open = before_file.skip().map_err(to_err)?;
        }
    }
}

fn extract_sevenz(
    ctx: &OpContext,
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
) -> CommandResult<OperationResult> {
    let password = match password {
        Some(p) => sevenz_rust::Password::from(p),
        None => sevenz_rust::Password::empty(),
    };
    let mut reader = sevenz_rust::SevenZReader::open(path, password).map_err(to_err)?;
    let total = reader.archive().files.len() as u64;
    let mut result = OperationResult { files: 0, bytes: 0 };
    let mut failure: Option<String> = None;
    let mut done = 0;
    reader
        .for_each_entries(|entry, entry_reader| {
            let mut step = |result: &mut OperationResult,
                        entry: &sevenz_rust::SevenZArchiveEntry,
                        entry_reader: &mut dyn Read|
             -> CommandResult<()> {
                ctx.check()?;
                done += 1;
                ctx.progress(done, total, &entry.name);
                if entry.is_directory() {
                    return Ok(());
                }
                let name = entry.name.replace('\\', "/");
                let selected = match selection {
                    None => true,
                    Some(selected) => selected.contains(&name),
                };
                if !selected {
                    // Il faut tout de même consommer le flux (archives solides).
                    io::copy(entry_reader, &mut io::sink()).map_err(to_err)?;
                    return Ok(());
                }
                let dest = safe_join(dest_dir, &name)?;
                if let Some(parent) = dest.parent() {
                    fs::create_dir_all(parent).map_err(to_err)?;
                }
                let mut out = File::create(&dest).map_err(to_err)?;
                io::copy(entry_reader, &mut out).map_err(to_err)?;
                result.files += 1;
                result.bytes += entry.size;
                Ok(())
            };
            match step(&mut result, entry, entry_reader) {
                Ok(()) => Ok(true),
                Err(error) => {
                    failure = Some(error);
                    Ok(false) // arrête le parcours des entrées
                }
            }
        })
        .map_err(to_err)?;
    if let Some(error) = failure {
        return Err(error);
    }
    Ok(result)
}

#[tauri::command]
async fn extract_archive(
    app: AppHandle,
    tokens: tauri::State<'_, CancelTokens>,
    id: String,
    path: String,
    dest_dir: String,
    password: Option<String>,
    entries: Option<Vec<String>>,
) -> CommandResult<OperationResult> {
    let path = PathBuf::from(path);
    let dest_dir = PathBuf::from(dest_dir);
    let password = normalize_password(&password);
    let selection: Option<HashSet<String>> =
        entries.map(|entries| entries.into_iter().collect());
    let result = extract_archive_inner(
        Some(&app),
        Some(&tokens),
        &id,
        &path,
        &dest_dir,
        password,
        selection.as_ref(),
    );
    // Consomme le jeton, que l'opération réussisse ou échoue.
    tokens.0.lock().unwrap().remove(&id);
    result
}

fn extract_archive_inner(
    app: Option<&AppHandle>,
    tokens: Option<&CancelTokens>,
    id: &str,
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
) -> CommandResult<OperationResult> {
    if !path.is_file() {
        return Err(format!("Fichier introuvable : {}", path.display()));
    }
    if !dest_dir.is_dir() {
        return Err(format!("Dossier de destination introuvable : {}", dest_dir.display()));
    }
    let ctx = OpContext { app, tokens, id };
    match detect_format(path)? {
        "zip" => extract_zip(&ctx, path, dest_dir, password, selection),
        "rar" => extract_rar(&ctx, path, dest_dir, password, selection),
        _ => extract_sevenz(&ctx, path, dest_dir, password, selection),
    }
}

/// Demande l'annulation de l'opération identifiée par `id`.
#[tauri::command]
async fn cancel_operation(tokens: tauri::State<'_, CancelTokens>, id: String) -> CommandResult<()> {
    tokens.0.lock().unwrap().insert(id);
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
    let mut file = File::open(path).map_err(to_err)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(to_err)?;
    zip.start_file(name, options).map_err(|e| map_zip_err(e, name))?;
    zip.write_all(&data).map_err(to_err)?;
    result.files += 1;
    result.bytes += data.len() as u64;
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
    let entries = fs::read_dir(dir).map_err(to_err)?;
    for entry in entries {
        let entry = entry.map_err(to_err)?;
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

fn map_zip_err(error: ZipError, name: &str) -> String {
    match error {
        ZipError::UnsupportedArchive(reason) => format!("Entrée non supportée ({reason}) : {name}"),
        other => format!("{other} — {name}"),
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
            .ok_or_else(|| format!("Chemin source invalide : {}", source.display()))?
            .to_string_lossy()
            .to_string();
        if source.is_dir() {
            zip.add_directory(&name, options).map_err(to_err)?;
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
    tokens: tauri::State<'_, CancelTokens>,
    id: String,
    dest: String,
    sources: Vec<String>,
) -> CommandResult<OperationResult> {
    let dest = PathBuf::from(&dest);
    let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    let result = create_zip_inner(Some(&app), Some(&tokens), &id, &dest, &sources);
    // Consomme le jeton, que l'opération réussisse ou échoue.
    tokens.0.lock().unwrap().remove(&id);
    result
}

fn create_zip_inner(
    app: Option<&AppHandle>,
    tokens: Option<&CancelTokens>,
    id: &str,
    dest: &Path,
    sources: &[PathBuf],
) -> CommandResult<OperationResult> {
    if sources.is_empty() {
        return Err("Aucun fichier source fourni.".into());
    }
    if dest.exists() {
        return Err("Le fichier de destination existe déjà.".into());
    }
    let ctx = OpContext { app, tokens, id };
    let total = count_sources(sources);
    let mut result = OperationResult { files: 0, bytes: 0 };
    let file = File::create(dest).map_err(to_err)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    // `finish` consomme le writer : la chaîne ci-dessous garantit sa
    // destruction (donc la fermeture du fichier) avant le nettoyage.
    let outcome = write_sources(&ctx, total, &mut zip, sources, options, &mut result)
        .and_then(|_| zip.finish().map_err(to_err));
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
        .manage(CancelTokens::default())
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

    #[test]
    fn safe_join_refuse_la_traversee_de_chemin() {
        let root = Path::new("dest");
        assert!(safe_join(root, "../secret.txt").is_err());
        assert!(safe_join(root, "a/../../secret.txt").is_err());
        assert!(safe_join(root, "/absolu.txt").is_err());
        assert!(safe_join(root, "C:\\windows\\evil.txt").is_err());
        assert!(safe_join(root, "dossier/fichier.txt").is_ok());
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
        let extracted = extract_archive_inner(None, None, "", &archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(
            fs::read_to_string(out.join("sources/a.txt")).unwrap(),
            "contenu A"
        );

        // Extraction sélective : seul b.txt est écrit
        let out2 = root.join("out2");
        fs::create_dir_all(&out2).unwrap();
        let selection: HashSet<String> = ["sources/sous-dossier/b.txt".to_string()]
            .into_iter()
            .collect();
        extract_archive_inner(None, None, "", &archive, &out2, None, Some(&selection)).unwrap();
        assert!(out2.join("sources/sous-dossier/b.txt").is_file());
        assert!(!out2.join("sources/a.txt").exists());

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn roundtrip_sevenz() {
        let root = temp_root("7z");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        write(&source_dir.join("b.txt"), "contenu B");
        let archive = root.join("test.7z");

        sevenz_rust::compress_to_path(&source_dir, &archive).unwrap();

        let entries = list_archive_inner(&archive, None).unwrap();
        assert!(entries.iter().any(|e| e.path == "a.txt"));

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract_archive_inner(None, None, "", &archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 2);
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

        let tokens = CancelTokens::default();
        tokens.0.lock().unwrap().insert("op-1".into());
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let error = extract_archive_inner(None, Some(&tokens), "op-1", &archive, &out, None, None)
            .unwrap_err();
        assert!(error.contains("annulée"));

        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn creation_annulee_ne_laisse_pas_darchive_partielle() {
        let root = temp_root("cancel-create");
        let source_dir = root.join("sources");
        write(&source_dir.join("a.txt"), "contenu A");
        let archive = root.join("partiel.zip");

        let tokens = CancelTokens::default();
        tokens.0.lock().unwrap().insert("op-2".into());
        let error =
            create_zip_inner(None, Some(&tokens), "op-2", &archive, &[source_dir]).unwrap_err();
        assert!(error.contains("annulée"));
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
        assert!(extract_archive_inner(None, None, "", &archive, &out, None, None).is_err());

        let out2 = root.join("out2");
        fs::create_dir_all(&out2).unwrap();
        let extracted = extract_archive_inner(None, None, "", &archive, &out2, Some(password), None).unwrap();
        assert_eq!(extracted.files, 1);
        assert_eq!(
            fs::read_to_string(out2.join("a.txt")).unwrap(),
            "contenu secret"
        );

        fs::remove_dir_all(&root).unwrap();
    }
}
