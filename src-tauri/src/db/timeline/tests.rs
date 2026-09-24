use super::*;
use crate::db::{media, open_project_db, projects::ProjectFormat};
use crate::media::types::{AudioStreamInfo, MediaKind, MediaMetadata};
use crate::timeline::{Hook, Transform};

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
        hook: Hook::default(),
        captions: Default::default(),
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

#[test]
fn captions_style_arabic_words_and_emphasis_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("project.db");
    let conn = open_project_db(&path).unwrap();
    let mut timeline = fixture(&conn);
    timeline.captions.style.direction = "rtl".into();
    timeline.captions.style.preset = "arabic".into();
    timeline
        .captions
        .segments
        .push(crate::captions::CaptionSegment {
            id: "caption".into(),
            start: 1.0,
            end: 2.0,
            words: vec![crate::captions::CaptionWord {
                text: "مرحبا".into(),
                start: 1.0,
                end: 2.0,
                emphasis: true,
            }],
        });
    save(&conn, &timeline).unwrap();
    drop(conn);
    let conn = open_project_db(&path).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline.clone()));
    let mut invalid = timeline.clone();
    invalid.captions.segments[0].words[0].start = -1.0;
    assert!(save(&conn, &invalid).is_err());
    assert_eq!(load(&conn).unwrap(), Some(timeline));
}

#[test]
fn captions_survive_media_trim_without_extending_timeline_duration() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let mut timeline = fixture(&conn);
    timeline
        .captions
        .segments
        .push(crate::captions::CaptionSegment {
            id: "later".into(),
            start: 20.0,
            end: 21.0,
            words: vec![crate::captions::CaptionWord {
                text: "Later".into(),
                start: 20.0,
                end: 21.0,
                emphasis: false,
            }],
        });
    save(&conn, &timeline).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline));
}

#[test]
fn old_client_timeline_gets_empty_default_captions() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let timeline = fixture(&conn);
    let mut value = serde_json::to_value(&timeline).unwrap();
    value.as_object_mut().unwrap().remove("captions");
    let decoded: Timeline = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.captions, crate::captions::CaptionTrack::default());
}

#[test]
fn phase_four_database_migrates_with_default_captions_and_preserves_hook() {
    let mut conn = Connection::open_in_memory().unwrap();
    let migrations = &crate::db::project_schema::PROJECT_MIGRATIONS;
    crate::db::migrations::apply(&mut conn, &migrations[..2], "test").unwrap();
    let hook = crate::timeline::Hook {
        enabled: false,
        duration: 2.0,
        background: "#123456".into(),
        layers: vec![],
    };
    conn.execute("INSERT INTO timelines (id,name,width,height,fps,duration_sec,hook_json,created_at,updated_at) VALUES ('main','Old',1080,1920,30,0,?1,'now','now')", [serde_json::to_string(&hook).unwrap()]).unwrap();
    crate::db::migrations::apply(&mut conn, migrations, "test").unwrap();
    let timeline = load(&conn).unwrap().unwrap();
    assert_eq!(timeline.hook, hook);
    assert_eq!(timeline.captions, crate::captions::CaptionTrack::default());
    crate::db::migrations::apply(&mut conn, migrations, "test").unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline));
}

#[test]
fn invalid_persisted_caption_json_is_rejected_on_load() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let timeline = fixture(&conn);
    save(&conn, &timeline).unwrap();
    let mut invalid = timeline.captions;
    invalid.style.font_size = -1.0;
    conn.execute(
        "UPDATE timelines SET captions_json = ?1",
        [serde_json::to_string(&invalid).unwrap()],
    )
    .unwrap();
    assert!(load(&conn).is_err());
}
