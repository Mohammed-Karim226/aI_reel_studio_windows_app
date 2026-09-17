//! On-disk project layout (spec §25).
//!
//! A project is a directory that carries everything needed to reopen it: a portable
//! `project.json` manifest, its own `project.db`, and one subdirectory per artifact class.
//! Nothing here holds media binaries — source footage stays where the user keeps it (§4.2).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::db::projects::ProjectFormat;
use crate::error::{AppError, AppResult};
use crate::media::types::DerivativeKind;

/// Directories every project owns. Created eagerly so the project is self-describing.
pub const PROJECT_DIRS: [&str; 9] = [
    "media",
    "proxies",
    "thumbnails",
    "captions",
    "assets",
    "templates",
    "brands",
    "previews",
    "renders",
];

pub const MANIFEST_FILE: &str = "project.json";
pub const DATABASE_FILE: &str = "project.db";

/// Portable manifest, readable without the application database. Kept deliberately small: the
/// authority for project data is `project.db`, this only describes the project to a human or a
/// future recovery tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectManifest {
    pub id: String,
    pub name: String,
    pub format: ProjectFormat,
    pub created_at: String,
}

pub fn manifest_path(root: &Path) -> PathBuf {
    root.join(MANIFEST_FILE)
}

pub fn database_path(root: &Path) -> PathBuf {
    root.join(DATABASE_FILE)
}

/// Returns the manifest if `root` looks like a project directory.
pub fn read_manifest(root: &Path) -> AppResult<ProjectManifest> {
    let path = manifest_path(root);
    if !path.is_file() {
        return Err(AppError::ProjectNotFound(format!(
            "{} does not contain {}",
            root.display(),
            MANIFEST_FILE
        )));
    }

    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).map_err(|error| {
        AppError::Internal(format!(
            "{} is not a valid manifest: {error}",
            path.display()
        ))
    })
}

pub fn write_manifest(root: &Path, manifest: &ProjectManifest) -> AppResult<()> {
    let text = serde_json::to_string_pretty(manifest)?;
    std::fs::write(manifest_path(root), text)?;
    Ok(())
}

/// Creates the project directory tree. Idempotent so reopening a project can call it safely.
pub fn create_layout(root: &Path) -> AppResult<()> {
    std::fs::create_dir_all(root)?;
    for dir in PROJECT_DIRS {
        std::fs::create_dir_all(root.join(dir))?;
    }
    Ok(())
}

/// Creates a project on disk: the directory tree, the project database with its single project
/// row, and the portable manifest. Returns the manifest that was written.
pub fn create_at(
    root: &Path,
    name: &str,
    format: ProjectFormat,
    created_at: &str,
) -> AppResult<ProjectManifest> {
    create_layout(root)?;

    let manifest = ProjectManifest {
        id: uuid::Uuid::new_v4().to_string(),
        name: name.to_string(),
        format,
        created_at: created_at.to_string(),
    };

    {
        let conn = crate::db::open_project_db(&database_path(root))?;
        crate::db::projects::insert_project_row(
            &conn,
            &manifest.id,
            &manifest.name,
            manifest.format,
            &manifest.created_at,
        )?;
    }

    write_manifest(root, &manifest)?;
    Ok(manifest)
}

/// Relative path (forward slashes, portable across moves) of a derivative inside the project.
pub fn derivative_relative_path(asset_id: &str, kind: DerivativeKind) -> String {
    match kind {
        DerivativeKind::Thumbnail => format!("thumbnails/{asset_id}.jpg"),
        DerivativeKind::Filmstrip => format!("thumbnails/{asset_id}.filmstrip.jpg"),
        DerivativeKind::Waveform => format!("captions/{asset_id}.waveform.json"),
        DerivativeKind::Proxy => format!("proxies/{asset_id}.mp4"),
    }
}

/// Resolves a project-relative path, refusing anything that escapes the project root.
///
/// Two layers of defence. The lexical fold catches `..` segments without touching the disk; the
/// canonical check catches junctions and symlinks inside the project, which a purely lexical
/// comparison cannot see but which would redirect a read or delete outside the project.
pub fn resolve_relative(root: &Path, relative: &str) -> AppResult<PathBuf> {
    let candidate = root.join(relative);
    let normalized = normalize(&candidate);
    let normalized_root = normalize(root);

    if !normalized.starts_with(&normalized_root) {
        return Err(escape_error(relative));
    }

    // The artifact itself may not exist yet, so validate the directory it will live in — that is
    // the component a junction could have redirected.
    if let Some(parent) = candidate.parent() {
        if let (Ok(canonical_root), Ok(canonical_parent)) =
            (root.canonicalize(), parent.canonicalize())
        {
            if !canonical_parent.starts_with(&canonical_root) {
                return Err(escape_error(relative));
            }
        }
    }

    Ok(candidate)
}

fn escape_error(relative: &str) -> AppError {
    AppError::InvalidInput(format!("path `{relative}` escapes the project directory"))
}

/// Where a derivative is rendered before it replaces the previous artifact.
///
/// Generating into a staging file keeps a failed or cancelled run from destroying an artifact
/// that was already good.
pub fn staging_path(output: &Path) -> PathBuf {
    let mut staging = output.as_os_str().to_os_string();
    staging.push(".partial");
    PathBuf::from(staging)
}

/// Lexical normalization (no filesystem access): folds `.` and `..` components away.
fn normalize(path: &Path) -> PathBuf {
    let mut parts: Vec<std::ffi::OsString> = Vec::new();

    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::CurDir => {}
            other => parts.push(other.as_os_str().to_os_string()),
        }
    }

    parts.iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_spec_directory_is_created() {
        let dir = tempfile::tempdir().expect("temp dir");
        create_layout(dir.path()).expect("layout");

        for expected in PROJECT_DIRS {
            assert!(
                dir.path().join(expected).is_dir(),
                "missing project directory {expected}"
            );
        }
    }

    #[test]
    fn layout_creation_is_idempotent() {
        let dir = tempfile::tempdir().expect("temp dir");
        create_layout(dir.path()).expect("first");
        create_layout(dir.path()).expect("second");
    }

    #[test]
    fn manifest_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        create_layout(dir.path()).expect("layout");

        let manifest = ProjectManifest {
            id: "p1".into(),
            name: "Podcast Reels".into(),
            format: ProjectFormat::default(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
        };
        write_manifest(dir.path(), &manifest).expect("write");

        assert_eq!(read_manifest(dir.path()).expect("read"), manifest);
    }

    #[test]
    fn a_directory_without_a_manifest_is_not_a_project() {
        let dir = tempfile::tempdir().expect("temp dir");
        let error = read_manifest(dir.path()).expect_err("no manifest");
        assert_eq!(error.kind(), "project_not_found");
    }

    #[test]
    fn a_created_project_can_be_reopened_from_its_directory() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("Podcast Reels");

        let manifest = create_at(
            &root,
            "Podcast Reels",
            ProjectFormat::default(),
            "2026-01-01T00:00:00+00:00",
        )
        .expect("create project");

        assert!(database_path(&root).is_file());
        assert_eq!(read_manifest(&root).expect("manifest"), manifest);

        // Reopening reads the database, which is the authority for project data.
        let conn = crate::db::open_project_db(&database_path(&root)).expect("reopen database");
        let (id, name, format, created_at) =
            crate::db::projects::read_project_row(&conn).expect("project row");
        assert_eq!(id, manifest.id);
        assert_eq!(name, "Podcast Reels");
        assert_eq!(format, ProjectFormat::default());
        assert_eq!(created_at, manifest.created_at);

        // Reopening also re-runs layout creation, which must be harmless.
        create_layout(&root).expect("layout is idempotent");
    }

    #[test]
    fn derivative_paths_are_grouped_by_artifact_class() {
        assert_eq!(
            derivative_relative_path("m1", DerivativeKind::Thumbnail),
            "thumbnails/m1.jpg"
        );
        assert_eq!(
            derivative_relative_path("m1", DerivativeKind::Filmstrip),
            "thumbnails/m1.filmstrip.jpg"
        );
        assert_eq!(
            derivative_relative_path("m1", DerivativeKind::Waveform),
            "captions/m1.waveform.json"
        );
        assert_eq!(
            derivative_relative_path("m1", DerivativeKind::Proxy),
            "proxies/m1.mp4"
        );
    }

    #[test]
    fn relative_paths_resolve_inside_the_project() {
        let root = Path::new(r"D:\projects\reel");
        let resolved = resolve_relative(root, "proxies/m1.mp4").expect("resolve");
        assert_eq!(resolved, root.join("proxies/m1.mp4"));
    }

    #[test]
    fn paths_that_escape_the_project_are_rejected() {
        let root = Path::new(r"D:\projects\reel");
        let error = resolve_relative(root, "../outside.mp4").expect_err("escape");
        assert_eq!(error.kind(), "invalid_input");
        assert!(resolve_relative(root, "proxies/../../../evil.txt").is_err());
    }

    #[test]
    fn artifacts_that_do_not_exist_yet_still_resolve() {
        let dir = tempfile::tempdir().expect("temp dir");
        create_layout(dir.path()).expect("layout");

        let path = resolve_relative(dir.path(), "thumbnails/new.jpg").expect("resolve");
        assert_eq!(path, dir.path().join("thumbnails/new.jpg"));
    }

    #[test]
    fn staging_paths_sit_next_to_the_final_artifact() {
        let output = Path::new(r"D:\p\proxies\m1.mp4");
        assert_eq!(
            staging_path(output),
            PathBuf::from(r"D:\p\proxies\m1.mp4.partial")
        );
    }

    #[test]
    fn normalization_folds_dot_segments() {
        let root = Path::new(r"D:\p");
        assert_eq!(
            resolve_relative(root, "thumbnails/./a.jpg").expect("resolve"),
            root.join("thumbnails/./a.jpg")
        );
    }
}
