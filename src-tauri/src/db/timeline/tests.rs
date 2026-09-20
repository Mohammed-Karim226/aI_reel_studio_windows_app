use super::*;
use crate::db::{media, open_project_db, projects::ProjectFormat};
use crate::media::types::{AudioStreamInfo, MediaKind, MediaMetadata};
use crate::timeline::Transform;

fn fixture(conn: &Connection) -> Timeline {
    media::insert_asset(
        conn,
        "media",
        "C:\\media.wav",
        "media.wav",
        &MediaMetadata {
            kind: MediaKind::Audio,
            container: Some("wav".into()),
            duration_sec: 60.0,
            size_bytes: 500,
            video: None,
            audio: Some(AudioStreamInfo {
                codec: "pcm".into(),
                channels: 2,
                sample_rate: 48000,
                bit_rate: None,
            }),
        },
        "{}",
    )
    .expect("asset");
    Timeline {
        version: 1,
        id: "main".into(),
        name: "Reel".into(),
        width: 1080,
        height: 1920,
        fps: 30.0,
        duration: 5.0,
        tracks: vec![Track {
            id: "audio".into(),
            kind: "audio".into(),
            name: "Audio 1".into(),
            enabled: true,
            locked: false,
            muted: false,
            solo: false,
            volume: 0.8,
            clips: vec![Clip {
                id: "clip".into(),
                source_media_id: "media".into(),
                label: "Podcast".into(),
                source_start: 10.0,
                source_end: 15.0,
                timeline_start: 0.0,
                timeline_end: 5.0,
                speed: 1.0,
                enabled: true,
                transform: Transform {
                    x: 0.0,
                    y: 0.0,
                    scale: 1.0,
                    rotation: 0.0,
                    opacity: 1.0,
                },
            }],
        }],
    }
}

#[test]
fn edits_survive_closing_and_reopening_the_project() {
    let dir = tempfile::tempdir().expect("temp");
    crate::project::create_at(dir.path(), "Reel", ProjectFormat::default(), "2026-01-01")
        .expect("project");
    let path = dir.path().join("project.db");
    let conn = open_project_db(&path).expect("db");
    assert!(load(&conn).expect("load").is_none());
    let timeline = fixture(&conn);
    save(&conn, &timeline).expect("save");
    drop(conn);
    let reopened = open_project_db(&path).expect("reopen");
    assert_eq!(load(&reopened).expect("load"), Some(timeline));
}

#[test]
fn failed_save_preserves_the_previous_timeline() {
    let conn = crate::db::open_project_db_in_memory().expect("db");
    let original = fixture(&conn);
    save(&conn, &original).expect("save");
    let mut edited = original.clone();
    edited.tracks[0].clips[0].source_media_id = "missing".into();
    assert!(save(&conn, &edited).is_err());
    assert_eq!(load(&conn).expect("load"), Some(original));
}

#[test]
fn rejects_invalid_versions_timing_overlap_and_source_bounds() {
    let conn = crate::db::open_project_db_in_memory().expect("db");
    let original = fixture(&conn);
    let mut bad = original.clone();
    bad.version = 2;
    assert!(save(&conn, &bad).is_err());
    let mut bad = original.clone();
    bad.tracks[0].clips[0].timeline_start = -1.0;
    assert!(save(&conn, &bad).is_err());
    let mut bad = original.clone();
    let mut overlapping = bad.tracks[0].clips[0].clone();
    overlapping.id = "second".into();
    bad.tracks[0].clips.push(overlapping);
    assert!(save(&conn, &bad).is_err());
    let mut bad = original;
    bad.tracks[0].clips[0].source_start = 59.0;
    bad.tracks[0].clips[0].source_end = 64.0;
    assert!(save(&conn, &bad).is_err());
    assert!(load(&conn).expect("load").is_none());
}

#[test]
fn moving_clips_between_tracks_and_removing_tracks_preserves_references() {
    let conn = crate::db::open_project_db_in_memory().expect("db");
    let mut timeline = fixture(&conn);
    save(&conn, &timeline).expect("save");
    assert!(media::delete_asset(&conn, "media").is_err());
    let mut second = timeline.tracks[0].clone();
    second.id = "second".into();
    timeline.tracks[0].clips.clear();
    timeline.tracks.push(second);
    save(&conn, &timeline).expect("move");
    timeline.tracks.reverse();
    save(&conn, &timeline).expect("reorder");
    timeline.tracks.pop();
    save(&conn, &timeline).expect("remove empty track");
    assert_eq!(load(&conn).expect("load"), Some(timeline.clone()));
    timeline.tracks[0].clips.clear();
    timeline.duration = 0.0;
    save(&conn, &timeline).expect("delete clips");
    media::delete_asset(&conn, "media").expect("unreferenced asset");
}
