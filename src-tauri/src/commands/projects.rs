//! Project lifecycle: create, open, list, close, forget (spec §25, §35).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tracing::{info, warn};

use crate::db;
use crate::db::media as media_db;
use crate::db::projects::{self, ProjectFormat, ProjectSummary};
use crate::error::{AppError, AppResult};
use crate::logging::category;
use crate::project::{self, ProjectManifest};
use crate::state::{AppState, OpenProject};

/// What the UI needs to render the open project.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInfo {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub format: ProjectFormat,
    pub media_count: usize,
}

fn info_for(
    conn: &rusqlite::Connection,
    summary: &ProjectSummary,
    format: ProjectFormat,
) -> AppResult<ProjectInfo> {
    Ok(ProjectInfo {
        id: summary.id.clone(),
        name: summary.name.clone(),
        root_path: summary.root_path.clone(),
        created_at: summary.created_at.clone(),
        format,
        media_count: media_db::list_assets(conn)?.len(),
    })
}

/// Opens a project directory and makes it the active project.
///
/// The project database is authoritative; `project.json` is only the portable manifest. An
/// unknown project is registered on the fly so opening a folder copied from another machine
/// works (spec §25: portable and recoverable).
fn activate(app: &AppHandle, state: &AppState, root: &Path) -> AppResult<ProjectInfo> {
    if !root.is_dir() {
        return Err(AppError::ProjectNotFound(root.display().to_string()));
    }

    // Fails with `project_not_found` when the directory is not a project.
    let manifest = project::read_manifest(root)?;
    let conn = open_or_rebuild_project_db(root, &manifest)?;
    let (id, name, format, created_at) = projects::read_project_row(&conn)?;

    let root_path = root.to_string_lossy().into_owned();
    let summary = {
        let app_db = state.app_db();
        match projects::find_by_root(&app_db, &root_path)? {
            Some(existing) => existing,
            None => {
                let summary = ProjectSummary {
                    id: id.clone(),
                    name: name.clone(),
                    root_path: root_path.clone(),
                    created_at: created_at.clone(),
                    updated_at: created_at.clone(),
                    last_opened_at: None,
                };
                projects::register(&app_db, &summary)?;
                info!(
                    target: category::DATABASE,
                    project = %id,
                    "registered a project that was not in the registry"
                );
                summary
            }
        }
    };

    {
        let app_db = state.app_db();
        projects::mark_opened(&app_db, &summary.id)?;
    }

    // Allow the WebView to read this project's derivatives (and the sources it references)
    // through the asset protocol. Without this the media panel would show broken images.
    app.asset_protocol_scope().allow_directory(root, true)?;

    state.set_project(Some(OpenProject {
        summary,
        root: root.to_path_buf(),
        format,
        db: conn,
    }));

    info!(
        target: category::DATABASE,
        project = %id,
        manifest = manifest.name,
        root = %root.display(),
        "project opened"
    );

    state.with_project(|project| info_for(&project.db, &project.summary, project.format))
}

#[tauri::command]
pub fn list_recent_projects(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> AppResult<Vec<ProjectSummary>> {
    let conn = state.app_db();
    projects::list_recent(&conn, limit.unwrap_or(20))
}

#[tauri::command]
pub fn create_project(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    parent_dir: Option<String>,
) -> AppResult<ProjectInfo> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(AppError::InvalidInput(
            "the project needs a name".to_string(),
        ));
    }

    let parent = match parent_dir.as_deref().map(str::trim) {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        _ => state.paths().default_projects_dir.clone(),
    };

    let root = parent.join(sanitize_dir_name(&name));
    if root.exists() {
        return Err(AppError::InvalidInput(format!(
            "{} already exists — choose another name or location",
            root.display()
        )));
    }

    let created_at = chrono::Utc::now().to_rfc3339();
    let format = ProjectFormat::default();

    let manifest = project::create_at(&root, &name, format, &created_at)?;

    {
        let app_db = state.app_db();
        projects::register(
            &app_db,
            &ProjectSummary {
                id: manifest.id.clone(),
                name: manifest.name.clone(),
                root_path: root.to_string_lossy().into_owned(),
                created_at: created_at.clone(),
                updated_at: created_at.clone(),
                last_opened_at: Some(created_at),
            },
        )?;
    }

    info!(
        target: category::DATABASE,
        project = %manifest.id,
        root = %root.display(),
        "project created"
    );

    activate(&app, &state, &root)
}

#[tauri::command]
pub fn open_project(
    app: AppHandle,
    state: State<'_, AppState>,
    root_path: String,
) -> AppResult<ProjectInfo> {
    activate(&app, &state, Path::new(root_path.trim()))
}

#[tauri::command]
pub fn close_project(state: State<'_, AppState>) {
    state.set_project(None);
}

#[tauri::command]
pub fn current_project(state: State<'_, AppState>) -> AppResult<Option<ProjectInfo>> {
    match state.with_project(|project| info_for(&project.db, &project.summary, project.format)) {
        Ok(info) => Ok(Some(info)),
        Err(AppError::NoProjectOpen) => Ok(None),
        Err(error) => Err(error),
    }
}

/// Removes a project from the recent list. Files on disk are never touched.
#[tauri::command]
pub fn forget_project(state: State<'_, AppState>, project_id: String) -> AppResult<()> {
    {
        let conn = state.app_db();
        projects::unregister(&conn, &project_id)?;
    }

    let is_open = state
        .with_project(|project| Ok(project.summary.id == project_id))
        .unwrap_or(false);
    if is_open {
        state.set_project(None);
    }
    Ok(())
}

/// Opens a project database, rebuilding the project row from the manifest when the database or its
/// single row is missing.
///
/// A project directory is portable (spec §25), so a half-copied folder, a cloud-sync placeholder
/// or a lost database must not brick the project. The manifest carries everything needed to make
/// the folder openable again; what a missing database loses is the media library, not the project.
fn open_or_rebuild_project_db(
    root: &Path,
    manifest: &ProjectManifest,
) -> AppResult<rusqlite::Connection> {
    let database = project::database_path(root);
    let existed = database.is_file();

    let conn = db::open_project_db(&database)?;

    if projects::find_project_row(&conn)?.is_some() {
        return Ok(conn);
    }

    warn!(
        target: category::DATABASE,
        project = %manifest.id,
        root = %root.display(),
        database_existed = existed,
        "project database had no project row; rebuilding it from the manifest"
    );
    projects::insert_project_row(
        &conn,
        &manifest.id,
        &manifest.name,
        manifest.format,
        &manifest.created_at,
    )?;

    Ok(conn)
}

/// Turns a project name into a directory name Windows accepts.
fn sanitize_dir_name(name: &str) -> String {
    const RESERVED: [char; 9] = ['<', '>', ':', '"', '/', '\\', '|', '?', '*'];

    let cleaned: String = name
        .chars()
        .map(|ch| {
            if RESERVED.contains(&ch) || ch.is_control() {
                '-'
            } else {
                ch
            }
        })
        .collect();

    // Windows strips trailing dots and spaces from directory names, which would silently change
    // the path we return to the caller.
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        "Untitled Reel".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> ProjectManifest {
        ProjectManifest {
            id: "p1".into(),
            name: "Podcast Reels".into(),
            format: ProjectFormat::default(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
        }
    }

    #[test]
    fn names_become_valid_windows_directories() {
        assert_eq!(sanitize_dir_name("Podcast: Ep 1"), "Podcast- Ep 1");
        assert_eq!(sanitize_dir_name("a/b\\c"), "a-b-c");
        assert_eq!(sanitize_dir_name("Q1 <draft>?"), "Q1 -draft--");
    }

    #[test]
    fn trailing_dots_and_spaces_are_removed() {
        assert_eq!(sanitize_dir_name("Reel. "), "Reel");
        assert_eq!(sanitize_dir_name("  Reel  "), "Reel");
    }

    #[test]
    fn an_empty_name_still_yields_a_directory() {
        assert_eq!(sanitize_dir_name("  "), "Untitled Reel");
        assert_eq!(sanitize_dir_name("???"), "---");
    }

    #[test]
    fn a_missing_database_is_rebuilt_from_the_manifest() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("Podcast Reels");
        project::create_layout(&root).expect("layout");
        let manifest = manifest();
        project::write_manifest(&root, &manifest).expect("manifest");

        // Before the fix this wrote a stray empty database and then failed every later open.
        let conn = open_or_rebuild_project_db(&root, &manifest).expect("rebuilt");
        let (id, name, format, created_at) =
            projects::read_project_row(&conn).expect("project row");
        assert_eq!(id, manifest.id);
        assert_eq!(name, manifest.name);
        assert_eq!(format, manifest.format);
        assert_eq!(created_at, manifest.created_at);
    }

    #[test]
    fn an_existing_project_database_is_left_alone() {
        let dir = tempfile::tempdir().expect("temp dir");
        let root = dir.path().join("Reel");
        let created = project::create_at(
            &root,
            "Original name",
            ProjectFormat::default(),
            "2026-01-01T00:00:00+00:00",
        )
        .expect("create");

        let conn = open_or_rebuild_project_db(&root, &created).expect("open");
        let (id, name, _, _) = projects::read_project_row(&conn).expect("project row");
        assert_eq!(id, created.id);
        assert_eq!(name, "Original name");
    }
}
