pub mod app_schema;
pub mod media;
pub mod migrations;
pub mod project_schema;
pub mod projects;
pub mod settings;
pub mod timeline;

use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;

use crate::error::AppResult;

/// Applied to every connection. WAL keeps reads non-blocking while a background job writes
/// derivative rows; `foreign_keys` is off by default in SQLite and must be enabled per connection.
const PRAGMAS: &str = "\
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
";

fn configure(conn: &Connection) -> AppResult<()> {
    // `execute_batch` tolerates the result row that `PRAGMA journal_mode` returns.
    conn.execute_batch(PRAGMAS)?;
    conn.busy_timeout(Duration::from_secs(5))?;
    Ok(())
}

fn open(path: &Path) -> AppResult<Connection> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(path)?;
    configure(&conn)?;
    Ok(conn)
}

/// Opens (creating if absent) and migrates the application-level database.
pub fn open_app_db(path: &Path) -> AppResult<Connection> {
    let mut conn = open(path)?;
    migrations::apply(&mut conn, &app_schema::APP_MIGRATIONS, "app")?;
    Ok(conn)
}

/// Opens (creating if absent) and migrates a project database.
pub fn open_project_db(path: &Path) -> AppResult<Connection> {
    let mut conn = open(path)?;
    migrations::apply(&mut conn, &project_schema::PROJECT_MIGRATIONS, "project")?;
    Ok(conn)
}

#[cfg(test)]
pub(crate) fn open_app_db_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrations::apply(&mut conn, &app_schema::APP_MIGRATIONS, "app")?;
    Ok(conn)
}

#[cfg(test)]
pub(crate) fn open_project_db_in_memory() -> AppResult<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrations::apply(&mut conn, &project_schema::PROJECT_MIGRATIONS, "project")?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_schema_creates_expected_tables() {
        let conn = open_app_db_in_memory().expect("app db");
        for table in [
            "app_settings",
            "project_registry",
            "brand_profiles",
            "hook_templates",
            "export_presets",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "missing table {table}");
        }
    }

    #[test]
    fn project_schema_creates_every_spec_entity() {
        let conn = open_project_db_in_memory().expect("project db");
        // Entity list from spec §26.
        for table in [
            "project",
            "media_assets",
            "media_derivatives",
            "timelines",
            "tracks",
            "timeline_clips",
            "captions",
            "caption_words",
            "text_elements",
            "animations",
            "keyframes",
            "effects",
            "render_jobs",
            "ai_analyses",
            "ai_suggestions",
        ] {
            let count: i64 = conn
                .query_row(
                    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .expect("query sqlite_master");
            assert_eq!(count, 1, "missing table {table}");
        }
    }

    #[test]
    fn foreign_keys_are_enforced() {
        let conn = open_project_db_in_memory().expect("project db");
        let result = conn.execute(
            "INSERT INTO media_derivatives (id, media_asset_id, kind, status, params_json, created_at, updated_at)
             VALUES ('d1', 'missing-asset', 'proxy', 'pending', '{}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            [],
        );
        assert!(result.is_err(), "dangling media_asset_id must be rejected");
    }

    #[test]
    fn clip_ranges_must_be_positive() {
        let conn = open_project_db_in_memory().expect("project db");
        conn.execute_batch(
            "INSERT INTO timelines (id, name, width, height, fps, created_at, updated_at)
             VALUES ('t1', 'Reel', 1080, 1920, 30.0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
             INSERT INTO tracks (id, timeline_id, kind, name, order_index)
             VALUES ('tr1', 't1', 'video', 'V1', 0);",
        )
        .expect("seed timeline and track");

        let result = conn.execute(
            "INSERT INTO timeline_clips
                (id, track_id, source_start, source_end, timeline_start, timeline_end, transform_json)
             VALUES ('c1', 'tr1', 5.0, 5.0, 0.0, 1.0, '{}')",
            [],
        );
        assert!(result.is_err(), "zero-length source range must be rejected");
    }
}
