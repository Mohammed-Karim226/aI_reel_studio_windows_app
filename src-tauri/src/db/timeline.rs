use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;
use crate::timeline::{invalid, Clip, Timeline, Track};

pub fn load(conn: &Connection) -> AppResult<Option<Timeline>> {
    let result = conn
        .query_row(
            "SELECT id, name, width, height, fps, duration_sec, hook_json, captions_json FROM timelines WHERE id = 'main'",
            [],
            |row| {
                Ok(Timeline {
                    version: 1,
                    id: row.get(0)?,
                    name: row.get(1)?,
                    width: row.get(2)?,
                    height: row.get(3)?,
                    fps: row.get(4)?,
                    duration: row.get(5)?,
                    hook: serde_json::from_str(&row.get::<_, String>(6)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(error)))?,
                    captions: serde_json::from_str(&row.get::<_, String>(7)?).map_err(|error| rusqlite::Error::FromSqlConversionFailure(7, rusqlite::types::Type::Text, Box::new(error)))?,
                    tracks: vec![],
                })
            },
        )
        .optional()?;
    let Some(mut timeline) = result else {
        return Ok(None);
    };
    let mut statement = conn.prepare("SELECT id, kind, name, enabled, locked, muted, solo, volume FROM tracks WHERE timeline_id = 'main' ORDER BY order_index")?;
    for row in statement.query_map([], |row| {
        Ok(Track {
            id: row.get(0)?,
            kind: row.get(1)?,
            name: row.get(2)?,
            enabled: row.get(3)?,
            locked: row.get(4)?,
            muted: row.get(5)?,
            solo: row.get(6)?,
            volume: row.get(7)?,
            clips: vec![],
        })
    })? {
        let mut track = row?;
        let mut clips = conn.prepare("SELECT id, source_media_id, label, source_start, source_end, timeline_start, timeline_end, speed, enabled, transform_json, effects_json FROM timeline_clips WHERE track_id = ?1 ORDER BY timeline_start")?;
        for row in clips.query_map([&track.id], |row| {
            let transform: String = row.get(9)?;
            let transform = serde_json::from_str(&transform).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    9,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            let effects: String = row.get(10)?;
            let effects = serde_json::from_str(&effects).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    10,
                    rusqlite::types::Type::Text,
                    Box::new(error),
                )
            })?;
            Ok(Clip {
                id: row.get(0)?,
                source_media_id: row.get(1)?,
                label: row.get::<_, Option<String>>(2)?.unwrap_or_default(),
                source_start: row.get(3)?,
                source_end: row.get(4)?,
                timeline_start: row.get(5)?,
                timeline_end: row.get(6)?,
                speed: row.get(7)?,
                enabled: row.get(8)?,
                transform,
                effects,
            })
        })? {
            track.clips.push(row?);
        }
        timeline.tracks.push(track);
    }
    timeline.validate()?;
    Ok(Some(timeline))
}

/// A transaction makes invalid references and failed writes leave the previous edit intact.
pub fn save(conn: &Connection, timeline: &Timeline) -> AppResult<()> {
    timeline.validate()?;
    let tx = conn.unchecked_transaction()?;
    for track in &timeline.tracks {
        for clip in &track.clips {
            let asset = super::media::get_asset(&tx, &clip.source_media_id)?;
            let compatible = match track.kind.as_str() {
                "video" => asset.has_video || asset.kind == crate::media::types::MediaKind::Image,
                "audio" | "sfx" => asset.has_audio,
                _ => false,
            };
            if !compatible
                || (asset.kind != crate::media::types::MediaKind::Image
                    && clip.source_end > asset.duration_sec + 0.00001)
            {
                return Err(invalid(
                    "clip source is incompatible with its track or exceeds the media duration",
                ));
            }
        }
    }
    let now = chrono::Utc::now().to_rfc3339();
    tx.execute("INSERT INTO timelines (id, name, duration_sec, width, height, fps, hook_json, captions_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, duration_sec=excluded.duration_sec, width=excluded.width, height=excluded.height, fps=excluded.fps, hook_json=excluded.hook_json, captions_json=excluded.captions_json, updated_at=excluded.updated_at",
        params![timeline.id, timeline.name, timeline.duration, timeline.width, timeline.height, timeline.fps, serde_json::to_string(&timeline.hook)?, serde_json::to_string(&timeline.captions)?, now])?;
    // Clear order slots before updating, so reordering cannot violate the unique index.
    tx.execute(
        "UPDATE tracks SET order_index = -order_index - 1 WHERE timeline_id = 'main'",
        [],
    )?;
    let previous = load_ids(&tx, "SELECT id FROM timeline_clips WHERE track_id IN (SELECT id FROM tracks WHERE timeline_id = 'main')")?;
    for id in previous {
        if !timeline
            .tracks
            .iter()
            .any(|track| track.clips.iter().any(|clip| clip.id == id))
        {
            tx.execute("DELETE FROM timeline_clips WHERE id = ?1", [id])?;
        }
    }
    for (index, track) in timeline.tracks.iter().enumerate() {
        tx.execute("INSERT INTO tracks (id, timeline_id, kind, name, order_index, enabled, locked, muted, solo, volume)
            VALUES (?1, 'main', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ON CONFLICT(id) DO UPDATE SET
            kind=excluded.kind, name=excluded.name, order_index=excluded.order_index, enabled=excluded.enabled,
            locked=excluded.locked, muted=excluded.muted, solo=excluded.solo, volume=excluded.volume",
            params![track.id, track.kind, track.name, index as i64, track.enabled, track.locked, track.muted, track.solo, track.volume])?;
    }
    for track in &timeline.tracks {
        for clip in &track.clips {
            tx.execute("INSERT INTO timeline_clips (id, track_id, source_media_id, label, source_start, source_end, timeline_start, timeline_end, speed, enabled, transform_json, effects_json)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) ON CONFLICT(id) DO UPDATE SET
                track_id=excluded.track_id, source_media_id=excluded.source_media_id, label=excluded.label,
                source_start=excluded.source_start, source_end=excluded.source_end, timeline_start=excluded.timeline_start,
                timeline_end=excluded.timeline_end, speed=excluded.speed, enabled=excluded.enabled, transform_json=excluded.transform_json, effects_json=excluded.effects_json",
                params![clip.id, track.id, clip.source_media_id, clip.label, clip.source_start, clip.source_end,
                    clip.timeline_start, clip.timeline_end, clip.speed, clip.enabled, serde_json::to_string(&clip.transform)?, serde_json::to_string(&clip.effects)?])?;
        }
    }
    for id in load_ids(&tx, "SELECT id FROM tracks WHERE timeline_id = 'main'")? {
        if !timeline.tracks.iter().any(|track| track.id == id) {
            tx.execute("DELETE FROM tracks WHERE id = ?1", [id])?;
        }
    }
    tx.execute("UPDATE project SET updated_at = ?1", [now])?;
    tx.commit()?;
    Ok(())
}

fn load_ids(conn: &Connection, sql: &str) -> AppResult<Vec<String>> {
    let mut statement = conn.prepare(sql)?;
    let ids = statement
        .query_map([], |row| row.get(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests;
