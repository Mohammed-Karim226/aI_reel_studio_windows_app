use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// Output format of a project's master composition. Defaults to the vertical Reel format
/// from spec §8.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFormat {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

impl Default for ProjectFormat {
    fn default() -> Self {
        Self {
            width: 1080,
            height: 1920,
            fps: 30.0,
        }
    }
}

/// A project as listed in the app-level registry. The registry holds only pointers; the
/// authoritative data lives in `<root_path>/project.db` and `<root_path>/project.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub last_opened_at: Option<String>,
}

fn summary_from_row(row: &Row<'_>) -> rusqlite::Result<ProjectSummary> {
    Ok(ProjectSummary {
        id: row.get("id")?,
        name: row.get("name")?,
        root_path: row.get("root_path")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        last_opened_at: row.get("last_opened_at")?,
    })
}

// ------------------------------------------------------------------ app registry

/// Column list shared by every registry query, so a schema change cannot leave one lookup behind.
const REGISTRY_COLUMNS: &str = "id, name, root_path, created_at, updated_at, last_opened_at";

/// Registers a project, resolving both unique keys.
///
/// `root_path` and `id` both have to be handled: a project directory copied to a new location
/// keeps its id but has a new root path, and a folder re-created from scratch can reuse a root
/// path with a fresh id. Without the first statement the copy fails on the id conflict; without
/// the upsert below the re-created folder fails on the root-path conflict.
pub fn register(conn: &Connection, summary: &ProjectSummary) -> AppResult<()> {
    let transaction = conn.unchecked_transaction()?;

    transaction.execute(
        "DELETE FROM project_registry WHERE root_path = ?1 AND id <> ?2",
        rusqlite::params![summary.root_path, summary.id],
    )?;

    transaction.execute(
        "INSERT INTO project_registry (id, name, root_path, created_at, updated_at, last_opened_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             root_path = excluded.root_path,
             updated_at = excluded.updated_at,
             last_opened_at = excluded.last_opened_at",
        rusqlite::params![
            summary.id,
            summary.name,
            summary.root_path,
            summary.created_at,
            summary.updated_at,
            summary.last_opened_at,
        ],
    )?;

    transaction.commit()?;
    Ok(())
}

pub fn list_recent(conn: &Connection, limit: u32) -> AppResult<Vec<ProjectSummary>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {REGISTRY_COLUMNS}
         FROM project_registry
         ORDER BY COALESCE(last_opened_at, updated_at) DESC
         LIMIT ?1"
    ))?;
    let rows = statement.query_map([limit], summary_from_row)?;

    let mut projects = Vec::new();
    for row in rows {
        projects.push(row?);
    }
    Ok(projects)
}

pub fn find_by_id(conn: &Connection, id: &str) -> AppResult<Option<ProjectSummary>> {
    Ok(conn
        .query_row(
            &format!("SELECT {REGISTRY_COLUMNS} FROM project_registry WHERE id = ?1"),
            [id],
            summary_from_row,
        )
        .optional()?)
}

pub fn find_by_root(conn: &Connection, root_path: &str) -> AppResult<Option<ProjectSummary>> {
    Ok(conn
        .query_row(
            &format!("SELECT {REGISTRY_COLUMNS} FROM project_registry WHERE root_path = ?1"),
            [root_path],
            summary_from_row,
        )
        .optional()?)
}

/// Records that a project was just opened, driving the "recent projects" ordering.
pub fn mark_opened(conn: &Connection, id: &str) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    let updated = conn.execute(
        "UPDATE project_registry SET last_opened_at = ?2, updated_at = ?2 WHERE id = ?1",
        rusqlite::params![id, now],
    )?;
    if updated == 0 {
        return Err(AppError::ProjectNotFound(id.to_string()));
    }
    Ok(())
}

/// Removes a project from the registry. Does not touch files on disk.
pub fn unregister(conn: &Connection, id: &str) -> AppResult<()> {
    conn.execute("DELETE FROM project_registry WHERE id = ?1", [id])?;
    Ok(())
}

// ------------------------------------------------------------------ project database

pub fn insert_project_row(
    conn: &Connection,
    id: &str,
    name: &str,
    format: ProjectFormat,
    created_at: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO project (id, name, created_at, updated_at, format_width, format_height, format_fps)
         VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            id,
            name,
            created_at,
            format.width,
            format.height,
            format.fps
        ],
    )?;
    Ok(())
}

/// Reads the single row of the `project` table, if the database has one.
pub fn find_project_row(
    conn: &Connection,
) -> AppResult<Option<(String, String, ProjectFormat, String)>> {
    Ok(conn
        .query_row(
            "SELECT id, name, format_width, format_height, format_fps, created_at FROM project LIMIT 1",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    ProjectFormat {
                        width: row.get(2)?,
                        height: row.get(3)?,
                        fps: row.get(4)?,
                    },
                    row.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?)
}

/// Reads the single row of the `project` table inside a project database.
pub fn read_project_row(conn: &Connection) -> AppResult<(String, String, ProjectFormat, String)> {
    find_project_row(conn)?
        .ok_or_else(|| AppError::Internal("project database has no project row".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{open_app_db_in_memory, open_project_db_in_memory};

    fn summary(id: &str, name: &str, root: &str, opened: Option<&str>) -> ProjectSummary {
        ProjectSummary {
            id: id.into(),
            name: name.into(),
            root_path: root.into(),
            created_at: "2026-01-01T00:00:00+00:00".into(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
            last_opened_at: opened.map(str::to_string),
        }
    }

    #[test]
    fn default_format_is_the_vertical_reel() {
        let format = ProjectFormat::default();
        assert_eq!((format.width, format.height), (1080, 1920));
        assert_eq!(format.fps, 30.0);
    }

    #[test]
    fn register_then_find_round_trips() {
        let conn = open_app_db_in_memory().expect("app db");
        let project = summary("p1", "Podcast Reels", r"D:\projects\podcast", None);
        register(&conn, &project).expect("register");

        assert_eq!(
            find_by_id(&conn, "p1").expect("find by id"),
            Some(project.clone())
        );
        assert_eq!(
            find_by_root(&conn, r"D:\projects\podcast").expect("find by root"),
            Some(project)
        );
    }

    #[test]
    fn registering_the_same_root_twice_updates_instead_of_duplicating() {
        let conn = open_app_db_in_memory().expect("app db");
        register(&conn, &summary("p1", "Old name", r"D:\p", None)).expect("first");
        register(&conn, &summary("p1", "New name", r"D:\p", None)).expect("second");

        let recent = list_recent(&conn, 10).expect("list");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].name, "New name");
    }

    #[test]
    fn registering_a_copied_project_moves_its_known_location() {
        let conn = open_app_db_in_memory().expect("app db");
        register(&conn, &summary("p1", "Reel", r"D:\original\reel", None)).expect("original");

        // A copied folder keeps the project id from its own project.db but has a new root path.
        register(&conn, &summary("p1", "Reel", r"E:\backup\reel", None)).expect("copy");

        let recent = list_recent(&conn, 10).expect("list");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].root_path, r"E:\backup\reel");
    }

    #[test]
    fn registering_a_recreated_project_replaces_the_stale_registry_row() {
        let conn = open_app_db_in_memory().expect("app db");
        register(&conn, &summary("old", "Old", r"D:\reel", None)).expect("old row");

        // Re-creating the folder produces a fresh id for the same path.
        register(&conn, &summary("new", "New", r"D:\reel", None)).expect("new row");

        let recent = list_recent(&conn, 10).expect("list");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "new");
    }

    #[test]
    fn recent_projects_are_ordered_by_last_opened() {
        let conn = open_app_db_in_memory().expect("app db");
        register(
            &conn,
            &summary("a", "A", r"D:\a", Some("2026-01-01T00:00:00+00:00")),
        )
        .expect("a");
        register(
            &conn,
            &summary("b", "B", r"D:\b", Some("2026-03-01T00:00:00+00:00")),
        )
        .expect("b");

        let recent = list_recent(&conn, 10).expect("list");
        assert_eq!(
            recent.iter().map(|p| p.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
    }

    #[test]
    fn mark_opened_moves_a_project_to_the_front() {
        let conn = open_app_db_in_memory().expect("app db");
        register(
            &conn,
            &summary("a", "A", r"D:\a", Some("2026-01-01T00:00:00+00:00")),
        )
        .expect("a");
        register(
            &conn,
            &summary("b", "B", r"D:\b", Some("2026-03-01T00:00:00+00:00")),
        )
        .expect("b");

        mark_opened(&conn, "a").expect("mark opened");
        let recent = list_recent(&conn, 10).expect("list");
        assert_eq!(recent[0].id, "a");
    }

    #[test]
    fn mark_opened_reports_unknown_projects() {
        let conn = open_app_db_in_memory().expect("app db");
        let error = mark_opened(&conn, "nope").expect_err("unknown project");
        assert_eq!(error.kind(), "project_not_found");
    }

    #[test]
    fn unregister_removes_only_the_named_project() {
        let conn = open_app_db_in_memory().expect("app db");
        register(&conn, &summary("a", "A", r"D:\a", None)).expect("a");
        register(&conn, &summary("b", "B", r"D:\b", None)).expect("b");

        unregister(&conn, "a").expect("unregister");
        let recent = list_recent(&conn, 10).expect("list");
        assert_eq!(recent.len(), 1);
        assert_eq!(recent[0].id, "b");
    }

    #[test]
    fn project_row_round_trips() {
        let conn = open_project_db_in_memory().expect("project db");
        let format = ProjectFormat {
            width: 1080,
            height: 1920,
            fps: 29.97,
        };
        insert_project_row(&conn, "p1", "My Reel", format, "2026-01-01T00:00:00+00:00")
            .expect("insert");

        let (id, name, stored_format, created_at) = read_project_row(&conn).expect("read");
        assert_eq!(id, "p1");
        assert_eq!(name, "My Reel");
        assert_eq!(stored_format, format);
        assert_eq!(created_at, "2026-01-01T00:00:00+00:00");
    }

    #[test]
    fn reading_an_empty_project_database_is_an_error() {
        let conn = open_project_db_in_memory().expect("project db");
        assert!(read_project_row(&conn).is_err());
    }
}
