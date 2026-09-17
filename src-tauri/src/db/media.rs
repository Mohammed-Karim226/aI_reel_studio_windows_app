use std::collections::HashMap;
use std::str::FromStr;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Row};

use crate::error::{AppError, AppResult};
use crate::media::types::{
    AudioStreamInfo, DerivativeKind, DerivativeStatus, MediaAsset, MediaDerivative, MediaKind,
    MediaMetadata, VideoStreamInfo,
};

const ASSET_COLUMNS: &str = "id, original_path, file_name, kind, container, size_bytes, \
     duration_sec, has_video, has_audio, video_codec, width, height, display_width, \
     display_height, fps, rotation, pix_fmt, video_bit_rate, audio_codec, audio_channels, \
     audio_sample_rate, audio_bit_rate, imported_at";

/// Column list shared by every derivative query, so a schema change cannot leave one query behind.
const DERIVATIVE_COLUMNS: &str =
    "id, media_asset_id, kind, status, relative_path, params_json, error, created_at, updated_at";

fn asset_from_row(row: &Row<'_>) -> rusqlite::Result<MediaAsset> {
    let has_video: bool = row.get("has_video")?;
    let has_audio: bool = row.get("has_audio")?;

    let video = if has_video {
        Some(VideoStreamInfo {
            codec: row
                .get::<_, Option<String>>("video_codec")?
                .unwrap_or_default(),
            width: row.get::<_, Option<u32>>("width")?.unwrap_or(0),
            height: row.get::<_, Option<u32>>("height")?.unwrap_or(0),
            display_width: row.get::<_, Option<u32>>("display_width")?.unwrap_or(0),
            display_height: row.get::<_, Option<u32>>("display_height")?.unwrap_or(0),
            fps: row.get::<_, Option<f64>>("fps")?.unwrap_or(0.0),
            rotation: row.get("rotation")?,
            pix_fmt: row.get("pix_fmt")?,
            bit_rate: row.get("video_bit_rate")?,
        })
    } else {
        None
    };

    let audio = if has_audio {
        Some(AudioStreamInfo {
            codec: row
                .get::<_, Option<String>>("audio_codec")?
                .unwrap_or_default(),
            channels: row.get::<_, Option<u32>>("audio_channels")?.unwrap_or(0),
            sample_rate: row.get::<_, Option<u32>>("audio_sample_rate")?.unwrap_or(0),
            bit_rate: row.get("audio_bit_rate")?,
        })
    } else {
        None
    };

    let kind_text: String = row.get("kind")?;
    let kind = MediaKind::from_str(&kind_text).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(error))
    })?;

    Ok(MediaAsset {
        id: row.get("id")?,
        original_path: row.get("original_path")?,
        file_name: row.get("file_name")?,
        kind,
        container: row.get("container")?,
        size_bytes: row.get("size_bytes")?,
        duration_sec: row.get("duration_sec")?,
        has_video,
        has_audio,
        video,
        audio,
        imported_at: row.get("imported_at")?,
        derivatives: Vec::new(),
    })
}

fn derivative_from_row(row: &Row<'_>) -> rusqlite::Result<MediaDerivative> {
    let kind_text: String = row.get("kind")?;
    let status_text: String = row.get("status")?;
    let params_text: String = row.get("params_json")?;

    let convert = |error: AppError| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(error))
    };

    Ok(MediaDerivative {
        id: row.get("id")?,
        media_asset_id: row.get("media_asset_id")?,
        kind: DerivativeKind::from_str(&kind_text).map_err(convert)?,
        status: DerivativeStatus::from_str(&status_text).map_err(convert)?,
        relative_path: row.get("relative_path")?,
        params: serde_json::from_str(&params_text).unwrap_or(serde_json::Value::Null),
        error: row.get("error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

// ------------------------------------------------------------------ assets

pub fn insert_asset(
    conn: &Connection,
    id: &str,
    original_path: &str,
    file_name: &str,
    metadata: &MediaMetadata,
    probe_json: &str,
) -> AppResult<()> {
    conn.execute(
        "INSERT INTO media_assets (
            id, original_path, file_name, kind, container, size_bytes, duration_sec,
            has_video, has_audio, video_codec, width, height, display_width, display_height,
            fps, rotation, pix_fmt, video_bit_rate, audio_codec, audio_channels,
            audio_sample_rate, audio_bit_rate, probe_json, imported_at
         ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6, ?7,
            ?8, ?9, ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?19, ?20,
            ?21, ?22, ?23, ?24
         )",
        rusqlite::params![
            id,
            original_path,
            file_name,
            metadata.kind.as_str(),
            metadata.container,
            metadata.size_bytes,
            metadata.duration_sec,
            metadata.video.is_some(),
            metadata.audio.is_some(),
            metadata.video.as_ref().map(|v| v.codec.clone()),
            metadata.video.as_ref().map(|v| v.width),
            metadata.video.as_ref().map(|v| v.height),
            metadata.video.as_ref().map(|v| v.display_width),
            metadata.video.as_ref().map(|v| v.display_height),
            metadata.video.as_ref().map(|v| v.fps),
            metadata.video.as_ref().map_or(0, |v| v.rotation),
            metadata.video.as_ref().and_then(|v| v.pix_fmt.clone()),
            metadata.video.as_ref().and_then(|v| v.bit_rate),
            metadata.audio.as_ref().map(|a| a.codec.clone()),
            metadata.audio.as_ref().map(|a| a.channels),
            metadata.audio.as_ref().map(|a| a.sample_rate),
            metadata.audio.as_ref().and_then(|a| a.bit_rate),
            probe_json,
            Utc::now().to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub fn find_asset_id_by_path(conn: &Connection, original_path: &str) -> AppResult<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM media_assets WHERE original_path = ?1",
            [original_path],
            |row| row.get::<_, String>(0),
        )
        .optional()?)
}

pub fn get_asset(conn: &Connection, id: &str) -> AppResult<MediaAsset> {
    let mut asset = conn
        .query_row(
            &format!("SELECT {ASSET_COLUMNS} FROM media_assets WHERE id = ?1"),
            [id],
            asset_from_row,
        )
        .optional()?
        .ok_or_else(|| AppError::MediaAssetNotFound(id.to_string()))?;

    asset.derivatives = list_derivatives(conn, id)?;
    Ok(asset)
}

pub fn list_assets(conn: &Connection) -> AppResult<Vec<MediaAsset>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {ASSET_COLUMNS} FROM media_assets ORDER BY imported_at DESC, file_name ASC"
    ))?;
    let mut assets = Vec::new();
    for row in statement.query_map([], asset_from_row)? {
        assets.push(row?);
    }

    // One extra query for all derivatives beats one query per asset.
    let mut grouped: HashMap<String, Vec<MediaDerivative>> = HashMap::new();
    let mut statement = conn.prepare(&format!(
        "SELECT {DERIVATIVE_COLUMNS} FROM media_derivatives"
    ))?;
    for row in statement.query_map([], derivative_from_row)? {
        let derivative = row?;
        grouped
            .entry(derivative.media_asset_id.clone())
            .or_default()
            .push(derivative);
    }

    for asset in &mut assets {
        if let Some(mut derivatives) = grouped.remove(&asset.id) {
            derivatives.sort_by_key(|d| d.kind.as_str());
            asset.derivatives = derivatives;
        }
    }

    Ok(assets)
}

pub fn delete_asset(conn: &Connection, id: &str) -> AppResult<()> {
    let removed = conn.execute("DELETE FROM media_assets WHERE id = ?1", [id])?;
    if removed == 0 {
        return Err(AppError::MediaAssetNotFound(id.to_string()));
    }
    Ok(())
}

// ------------------------------------------------------------------ derivatives

pub fn list_derivatives(
    conn: &Connection,
    media_asset_id: &str,
) -> AppResult<Vec<MediaDerivative>> {
    let mut statement = conn.prepare(&format!(
        "SELECT {DERIVATIVE_COLUMNS}
         FROM media_derivatives WHERE media_asset_id = ?1 ORDER BY kind"
    ))?;
    let mut derivatives = Vec::new();
    for row in statement.query_map([media_asset_id], derivative_from_row)? {
        derivatives.push(row?);
    }
    Ok(derivatives)
}

pub fn get_derivative(
    conn: &Connection,
    media_asset_id: &str,
    kind: DerivativeKind,
) -> AppResult<Option<MediaDerivative>> {
    Ok(conn
        .query_row(
            &format!(
                "SELECT {DERIVATIVE_COLUMNS}
                 FROM media_derivatives WHERE media_asset_id = ?1 AND kind = ?2"
            ),
            rusqlite::params![media_asset_id, kind.as_str()],
            derivative_from_row,
        )
        .optional()?)
}

/// Records (or re-records) a derivative. Re-running a failed derivative overwrites the previous
/// row rather than accumulating history, which is what the retry affordance in §29 needs.
#[allow(clippy::too_many_arguments)]
pub fn upsert_derivative(
    conn: &Connection,
    id: &str,
    media_asset_id: &str,
    kind: DerivativeKind,
    status: DerivativeStatus,
    relative_path: Option<&str>,
    params: &serde_json::Value,
    error: Option<&str>,
) -> AppResult<()> {
    let now = Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO media_derivatives
            (id, media_asset_id, kind, status, relative_path, params_json, error, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
         ON CONFLICT (media_asset_id, kind) DO UPDATE SET
             status = excluded.status,
             relative_path = excluded.relative_path,
             params_json = excluded.params_json,
             error = excluded.error,
             updated_at = excluded.updated_at",
        rusqlite::params![
            id,
            media_asset_id,
            kind.as_str(),
            status.as_str(),
            relative_path,
            serde_json::to_string(params)?,
            error,
            now,
        ],
    )?;
    Ok(())
}

/// Removes a derivative row. A cancelled run must not linger as if an artifact existed.
pub fn delete_derivative(
    conn: &Connection,
    media_asset_id: &str,
    kind: DerivativeKind,
) -> AppResult<()> {
    conn.execute(
        "DELETE FROM media_derivatives WHERE media_asset_id = ?1 AND kind = ?2",
        rusqlite::params![media_asset_id, kind.as_str()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_project_db_in_memory;

    fn metadata() -> MediaMetadata {
        MediaMetadata {
            kind: MediaKind::Video,
            container: Some("mov,mp4,m4a".into()),
            duration_sec: 3600.0,
            size_bytes: 4_294_967_296,
            video: Some(VideoStreamInfo {
                codec: "h264".into(),
                width: 3840,
                height: 2160,
                display_width: 3840,
                display_height: 2160,
                fps: 29.97,
                rotation: 0,
                pix_fmt: Some("yuv420p".into()),
                bit_rate: Some(45_000_000),
            }),
            audio: Some(AudioStreamInfo {
                codec: "aac".into(),
                channels: 2,
                sample_rate: 48_000,
                bit_rate: Some(192_000),
            }),
        }
    }

    fn seed(conn: &Connection) {
        insert_asset(
            conn,
            "m1",
            r"D:\media\podcast.mp4",
            "podcast.mp4",
            &metadata(),
            r#"{"streams":[]}"#,
        )
        .expect("insert asset");
    }

    #[test]
    fn insert_then_get_round_trips_every_field() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);

        let asset = get_asset(&conn, "m1").expect("get asset");
        assert_eq!(asset.file_name, "podcast.mp4");
        assert_eq!(asset.kind, MediaKind::Video);
        assert_eq!(asset.size_bytes, 4_294_967_296);
        assert_eq!(asset.duration_sec, 3600.0);
        assert!(asset.has_video && asset.has_audio);

        let video = asset.video.expect("video stream");
        assert_eq!(video.codec, "h264");
        assert_eq!((video.display_width, video.display_height), (3840, 2160));
        assert_eq!(video.fps, 29.97);

        let audio = asset.audio.expect("audio stream");
        assert_eq!(audio.channels, 2);
        assert_eq!(audio.sample_rate, 48_000);
    }

    #[test]
    fn large_files_survive_the_round_trip() {
        // 4 GiB exceeds i32; the column must stay 64-bit all the way through.
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        assert_eq!(get_asset(&conn, "m1").expect("get").size_bytes, 1 << 32);
    }

    #[test]
    fn audio_only_assets_have_no_video_stream() {
        let conn = open_project_db_in_memory().expect("project db");
        let audio_only = MediaMetadata {
            kind: MediaKind::Audio,
            video: None,
            ..metadata()
        };
        insert_asset(&conn, "a1", r"D:\a.mp3", "a.mp3", &audio_only, "{}").expect("insert");

        let asset = get_asset(&conn, "a1").expect("get");
        assert!(!asset.has_video);
        assert!(asset.video.is_none());
        assert!(asset.audio.is_some());
    }

    #[test]
    fn missing_asset_is_reported() {
        let conn = open_project_db_in_memory().expect("project db");
        let error = get_asset(&conn, "nope").expect_err("missing asset");
        assert_eq!(error.kind(), "media_asset_not_found");
    }

    #[test]
    fn find_by_path_detects_reimports() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        assert_eq!(
            find_asset_id_by_path(&conn, r"D:\media\podcast.mp4").expect("find"),
            Some("m1".to_string())
        );
        assert_eq!(
            find_asset_id_by_path(&conn, r"D:\media\other.mp4").expect("find"),
            None
        );
    }

    #[test]
    fn upsert_derivative_replaces_the_previous_attempt() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);

        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Proxy,
            DerivativeStatus::Failed,
            None,
            &serde_json::json!({ "height": 720 }),
            Some("ffmpeg crashed"),
        )
        .expect("first attempt");

        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Proxy,
            DerivativeStatus::Ready,
            Some("proxies/m1.mp4"),
            &serde_json::json!({ "height": 720 }),
            None,
        )
        .expect("retry");

        let derivatives = list_derivatives(&conn, "m1").expect("list");
        assert_eq!(derivatives.len(), 1);
        assert_eq!(derivatives[0].status, DerivativeStatus::Ready);
        assert_eq!(derivatives[0].error, None);
        assert_eq!(
            derivatives[0].relative_path.as_deref(),
            Some("proxies/m1.mp4")
        );
    }

    #[test]
    fn get_asset_includes_its_derivatives() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Waveform,
            DerivativeStatus::Ready,
            Some("captions/m1.waveform.json"),
            &serde_json::json!({ "buckets": 2000 }),
            None,
        )
        .expect("derivative");

        let asset = get_asset(&conn, "m1").expect("get");
        assert!(asset.has_ready_derivative(DerivativeKind::Waveform));
        assert_eq!(asset.derivatives.len(), 1);
    }

    #[test]
    fn list_assets_attaches_derivatives_to_the_right_asset() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        insert_asset(&conn, "m2", r"D:\b.mp4", "b.mp4", &metadata(), "{}").expect("second asset");

        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Proxy,
            DerivativeStatus::Ready,
            Some("proxies/m1.mp4"),
            &serde_json::Value::Null,
            None,
        )
        .expect("proxy");
        upsert_derivative(
            &conn,
            "d2",
            "m2",
            DerivativeKind::Thumbnail,
            DerivativeStatus::Ready,
            Some("thumbnails/m2.jpg"),
            &serde_json::Value::Null,
            None,
        )
        .expect("thumbnail");

        let assets = list_assets(&conn).expect("list");
        assert_eq!(assets.len(), 2);
        for asset in assets {
            assert_eq!(asset.derivatives.len(), 1);
            assert_eq!(asset.derivatives[0].media_asset_id, asset.id);
        }
    }

    #[test]
    fn deleting_an_asset_cascades_to_its_derivatives() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Proxy,
            DerivativeStatus::Ready,
            Some("proxies/m1.mp4"),
            &serde_json::Value::Null,
            None,
        )
        .expect("derivative");

        delete_asset(&conn, "m1").expect("delete");
        let remaining: i64 = conn
            .query_row("SELECT count(*) FROM media_derivatives", [], |row| {
                row.get(0)
            })
            .expect("count");
        assert_eq!(remaining, 0);
    }

    #[test]
    fn a_cancelled_derivative_can_be_removed() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Proxy,
            DerivativeStatus::Running,
            None,
            &serde_json::Value::Null,
            None,
        )
        .expect("derivative");

        delete_derivative(&conn, "m1", DerivativeKind::Proxy).expect("delete");
        assert!(get_derivative(&conn, "m1", DerivativeKind::Proxy)
            .expect("query")
            .is_none());
    }

    #[test]
    fn get_derivative_targets_one_kind() {
        let conn = open_project_db_in_memory().expect("project db");
        seed(&conn);
        upsert_derivative(
            &conn,
            "d1",
            "m1",
            DerivativeKind::Filmstrip,
            DerivativeStatus::Running,
            None,
            &serde_json::json!({ "frames": 40 }),
            None,
        )
        .expect("derivative");

        let found = get_derivative(&conn, "m1", DerivativeKind::Filmstrip)
            .expect("query")
            .expect("present");
        assert_eq!(found.status, DerivativeStatus::Running);
        assert_eq!(found.params["frames"], 40);

        assert!(get_derivative(&conn, "m1", DerivativeKind::Proxy)
            .expect("query")
            .is_none());
    }
}
