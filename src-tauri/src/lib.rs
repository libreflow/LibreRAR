use std::{
    collections::HashSet,
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use zip::{result::ZipError, write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub path: String,
    pub size: u64,
    pub compressed_size: u64,
    pub is_dir: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationResult {
    pub files: u64,
    pub bytes: u64,
}

type CommandResult<T> = Result<T, String>;

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

fn list_rar(path: &Path) -> CommandResult<Vec<ArchiveEntry>> {
    let archive = unrar::Archive::new(path);
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

fn list_sevenz(path: &Path) -> CommandResult<Vec<ArchiveEntry>> {
    let reader = sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty())
        .map_err(to_err)?;
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
async fn list_archive(path: String) -> CommandResult<Vec<ArchiveEntry>> {
    let path = PathBuf::from(path);
    list_archive_inner(&path)
}

fn list_archive_inner(path: &Path) -> CommandResult<Vec<ArchiveEntry>> {
    if !path.is_file() {
        return Err(format!("Fichier introuvable : {}", path.display()));
    }
    match detect_format(path)? {
        "zip" => list_zip(path),
        "rar" => list_rar(path),
        _ => list_sevenz(path),
    }
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

fn extract_zip(
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
) -> CommandResult<OperationResult> {
    let file = File::open(path).map_err(to_err)?;
    let mut archive = ZipArchive::new(file).map_err(to_err)?;
    let mut files = 0;
    let mut bytes = 0;
    for index in 0..archive.len() {
        // by_index_raw permet d'inspecter l'entrée avant décompression.
        let header = archive.by_index_raw(index).map_err(to_err)?;
        let name = header.name().replace('\\', "/");
        let is_dir = header.is_dir();
        let size = header.size();
        let encrypted = header.encrypted();
        drop(header);

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
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<&HashSet<String>>,
) -> CommandResult<OperationResult> {
    let archive = match password {
        Some(password) => unrar::Archive::with_password(path, password),
        None => unrar::Archive::new(path),
    };
    let mut open = archive.open_for_processing().map_err(to_err)?;
    let mut files = 0;
    let mut bytes = 0;
    loop {
        let before_file = match open.read_header().map_err(to_err)? {
            Some(next) => next,
            None => return Ok(OperationResult { files, bytes }),
        };
        let header = before_file.entry();
        let name = header.filename.to_string_lossy().replace('\\', "/");
        let is_dir = header.is_directory();
        let size = header.unpacked_size;

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
    let mut result = OperationResult { files: 0, bytes: 0 };
    let mut failure: Option<String> = None;
    reader
        .for_each_entries(|entry, entry_reader| {
            let step = |result: &mut OperationResult,
                        entry: &sevenz_rust::SevenZArchiveEntry,
                        entry_reader: &mut dyn Read|
             -> CommandResult<()> {
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
    extract_archive_inner(&path, &dest_dir, password, selection)
}

fn extract_archive_inner(
    path: &Path,
    dest_dir: &Path,
    password: Option<&str>,
    selection: Option<HashSet<String>>,
) -> CommandResult<OperationResult> {
    if !path.is_file() {
        return Err(format!("Fichier introuvable : {}", path.display()));
    }
    if !dest_dir.is_dir() {
        return Err(format!("Dossier de destination introuvable : {}", dest_dir.display()));
    }
    match detect_format(path)? {
        "zip" => extract_zip(path, dest_dir, password, selection.as_ref()),
        "rar" => extract_rar(path, dest_dir, password, selection.as_ref()),
        _ => extract_sevenz(path, dest_dir, password, selection.as_ref()),
    }
}

// ---------------------------------------------------------------------------
// Création d'archives ZIP
// ---------------------------------------------------------------------------

fn add_file_to_zip<W: Write + io::Seek>(
    zip: &mut ZipWriter<W>,
    name: &str,
    path: &Path,
    options: SimpleFileOptions,
    result: &mut OperationResult,
) -> CommandResult<()> {
    let mut file = File::open(path).map_err(to_err)?;
    let mut data = Vec::new();
    file.read_to_end(&mut data).map_err(to_err)?;
    zip.start_file(name, options).map_err(|e| map_zip_err(e, name))?;
    zip.write_all(&data).map_err(to_err)?;
    result.files += 1;
    result.bytes += data.len() as u64;
    Ok(())
}

fn add_dir_to_zip<W: Write + io::Seek>(
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
            add_dir_to_zip(zip, &format!("{zip_name}/"), &path, options, result)?;
        } else {
            add_file_to_zip(zip, &zip_name, &path, options, result)?;
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

#[tauri::command]
async fn create_zip(dest: String, sources: Vec<String>) -> CommandResult<OperationResult> {
    let dest = PathBuf::from(&dest);
    let sources: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    create_zip_inner(&dest, &sources)
}

fn create_zip_inner(
    dest: &Path,
    sources: &[PathBuf],
) -> CommandResult<OperationResult> {
    if sources.is_empty() {
        return Err("Aucun fichier source fourni.".into());
    }
    if dest.exists() {
        return Err("Le fichier de destination existe déjà.".into());
    }
    let mut result = OperationResult { files: 0, bytes: 0 };
    let file = File::create(dest).map_err(to_err)?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for source in sources {
        let source = source.as_path();
        let name = source
            .file_name()
            .ok_or_else(|| format!("Chemin source invalide : {}", source.display()))?
            .to_string_lossy()
            .to_string();
        if source.is_dir() {
            zip.add_directory(&name, options).map_err(to_err)?;
            add_dir_to_zip(&mut zip, &format!("{name}/"), source, options, &mut result)?;
        } else {
            add_file_to_zip(&mut zip, &name, source, options, &mut result)?;
        }
    }
    zip.finish().map_err(to_err)?;
    Ok(result)
}

// ---------------------------------------------------------------------------
// Point d'entrée Tauri
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_archive,
            extract_archive,
            create_zip
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

        let created = create_zip_inner(&archive, &[source_dir.clone()]).unwrap();
        assert_eq!(created.files, 2);

        let entries = list_archive_inner(&archive).unwrap();
        let names: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
        assert!(names.contains(&"sources/a.txt".to_string()));
        assert!(names.contains(&"sources/sous-dossier/b.txt".to_string()));

        // Extraction complète
        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract_archive_inner(&archive, &out, None, None).unwrap();
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
        extract_archive_inner(&archive, &out2, None, Some(selection)).unwrap();
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

        let entries = list_archive_inner(&archive).unwrap();
        assert!(entries.iter().any(|e| e.path == "a.txt"));

        let out = root.join("out");
        fs::create_dir_all(&out).unwrap();
        let extracted = extract_archive_inner(&archive, &out, None, None).unwrap();
        assert_eq!(extracted.files, 2);
        assert_eq!(fs::read_to_string(out.join("a.txt")).unwrap(), "contenu A");

        fs::remove_dir_all(&root).unwrap();
    }
}
