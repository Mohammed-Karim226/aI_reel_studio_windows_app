use std::collections::BTreeMap;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};

use crate::error::AppResult;

/// Known setting keys. Values are stored as text; callers parse.
pub mod keys {
    /// Absolute path to `ffmpeg.exe`, set by the user when auto-detection fails.
    pub const FFMPEG_PATH: &str = "ffmpeg.path";
    /// Absolute path to `ffprobe.exe`. Defaults to a sibling of `ffmpeg.exe`.
    pub const FFPROBE_PATH: &str = "ffprobe.path";
    /// Override for where proxies/thumbnails/waveforms are written (spec §34).
    pub const MEDIA_CACHE_DIR: &str = "media.cacheDir";
    /// Target height in pixels for generated proxies.
    pub const PROXY_HEIGHT: &str = "media.proxyHeight";
    /// Native caption setup, written as one JSON value so all fields change together.
    pub const TRANSCRIPTION_SETUP: &str = "transcription.setup";
}

pub fn get(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

pub fn set(conn: &Connection, key: &str, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, key: &str) -> AppResult<()> {
    conn.execute("DELETE FROM app_settings WHERE key = ?1", [key])?;
    Ok(())
}

pub fn all(conn: &Connection) -> AppResult<BTreeMap<String, String>> {
    let mut statement = conn.prepare("SELECT key, value FROM app_settings ORDER BY key")?;
    let rows = statement.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut settings = BTreeMap::new();
    for row in rows {
        let (key, value) = row?;
        settings.insert(key, value);
    }
    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_app_db_in_memory;

    #[test]
    fn get_returns_none_for_unset_keys() {
        let conn = open_app_db_in_memory().expect("app db");
        assert_eq!(get(&conn, keys::FFMPEG_PATH).expect("get"), None);
    }

    #[test]
    fn set_inserts_then_updates() {
        let conn = open_app_db_in_memory().expect("app db");
        set(&conn, keys::FFMPEG_PATH, r"C:\a\ffmpeg.exe").expect("insert");
        assert_eq!(
            get(&conn, keys::FFMPEG_PATH).expect("get"),
            Some(r"C:\a\ffmpeg.exe".to_string())
        );

        set(&conn, keys::FFMPEG_PATH, r"C:\b\ffmpeg.exe").expect("update");
        assert_eq!(
            get(&conn, keys::FFMPEG_PATH).expect("get"),
            Some(r"C:\b\ffmpeg.exe".to_string())
        );

        let count: i64 = conn
            .query_row("SELECT count(*) FROM app_settings", [], |row| row.get(0))
            .expect("count");
        assert_eq!(count, 1, "upsert must not duplicate the key");
    }

    #[test]
    fn remove_clears_a_key() {
        let conn = open_app_db_in_memory().expect("app db");
        set(&conn, keys::PROXY_HEIGHT, "720").expect("insert");
        remove(&conn, keys::PROXY_HEIGHT).expect("remove");
        assert_eq!(get(&conn, keys::PROXY_HEIGHT).expect("get"), None);
    }

    #[test]
    fn all_returns_every_setting() {
        let conn = open_app_db_in_memory().expect("app db");
        set(&conn, keys::PROXY_HEIGHT, "720").expect("insert");
        set(&conn, keys::MEDIA_CACHE_DIR, r"D:\cache").expect("insert");

        let settings = all(&conn).expect("all");
        assert_eq!(settings.len(), 2);
        assert_eq!(
            settings.get(keys::MEDIA_CACHE_DIR).map(String::as_str),
            Some(r"D:\cache")
        );
    }
}
