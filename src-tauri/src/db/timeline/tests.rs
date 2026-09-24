use super::*;
use crate::db::{media, open_project_db, projects::ProjectFormat};
use crate::effects::{Effect, EffectAnimation, EffectKeyframe, EffectType};
use crate::media::types::{AudioStreamInfo, MediaKind, MediaMetadata, VideoStreamInfo};
use crate::timeline::{Hook, HookAnimation, HookKeyframe, HookLayer, HookStyle, Transform};

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
                effects: vec![],
            }],
        }],
    }
}

fn video_fixture(conn: &Connection) -> Timeline {
    let mut timeline = fixture(conn);
    media::insert_asset(
        conn,
        "video-media",
        "C:\\scene.mp4",
        "scene.mp4",
        &MediaMetadata {
            kind: MediaKind::Video,
            container: Some("mp4".into()),
            duration_sec: 60.0,
            size_bytes: 1000,
            video: Some(VideoStreamInfo {
                codec: "h264".into(),
                width: 1920,
                height: 1080,
                display_width: 1920,
                display_height: 1080,
                fps: 30.0,
                rotation: 0,
                pix_fmt: Some("yuv420p".into()),
                bit_rate: None,
            }),
            audio: None,
        },
        "{}",
    )
    .unwrap();
    let mut video = timeline.tracks[0].clone();
    video.id = "video".into();
    video.kind = "video".into();
    video.name = "Video 1".into();
    video.clips[0].id = "video-clip".into();
    video.clips[0].source_media_id = "video-media".into();
    video.clips[0].label = "Scene".into();
    video.clips[0].timeline_start = 2.0;
    video.clips[0].timeline_end = 7.0;
    video.clips[0].transform = Transform {
        x: 15.0,
        y: -20.0,
        scale: 1.25,
        rotation: 5.0,
        opacity: 0.8,
    };
    timeline.hook.layers.push(HookLayer {
        id: "hook-title".into(),
        role: "main".into(),
        text: "Watch this".into(),
        start: 0.0,
        end: 1.5,
        style: HookStyle {
            font_size: 64.0,
            color: "#ffffff".into(),
            background: "transparent".into(),
            weight: "bold".into(),
            align: "center".into(),
        },
        transform: video.clips[0].transform.clone(),
        animations: vec![HookAnimation {
            property: "opacity".into(),
            keyframes: vec![
                HookKeyframe {
                    time: 0.0,
                    value: 0.0,
                    easing: "linear".into(),
                },
                HookKeyframe {
                    time: 0.5,
                    value: 1.0,
                    easing: "ease-out".into(),
                },
            ],
        }],
    });
    timeline.captions.style.preset = "arabic".into();
    timeline.captions.style.direction = "rtl".into();
    timeline
        .captions
        .segments
        .push(crate::captions::CaptionSegment {
            id: "caption".into(),
            start: 2.0,
            end: 3.0,
            words: vec![crate::captions::CaptionWord {
                text: "مرحبا".into(),
                start: 2.0,
                end: 3.0,
                emphasis: true,
            }],
        });
    timeline.duration = 7.0;
    timeline.tracks.insert(0, video);
    timeline
}

fn effect_stack() -> Vec<Effect> {
    vec![
        Effect {
            id: "grade".into(),
            kind: EffectType::Color,
            enabled: true,
            params: [
                ("brightness", 1.1),
                ("contrast", 1.2),
                ("saturation", 0.9),
                ("temperature", 0.25),
                ("tint", -0.1),
            ]
            .into_iter()
            .map(|(key, value)| (key.into(), value))
            .collect(),
            animations: vec![],
        },
        Effect {
            id: "punch".into(),
            kind: EffectType::PunchZoom,
            enabled: true,
            params: [("scale", 1.0), ("centerX", 40.0), ("centerY", 60.0)]
                .into_iter()
                .map(|(key, value)| (key.into(), value))
                .collect(),
            animations: vec![EffectAnimation {
                property: "scale".into(),
                // Frames outside the trimmed source range must survive future edits.
                keyframes: vec![
                    EffectKeyframe {
                        time: 9.5,
                        value: 1.0,
                        easing: "linear".into(),
                    },
                    EffectKeyframe {
                        time: 10.2,
                        value: 1.3,
                        easing: "ease-out".into(),
                    },
                    EffectKeyframe {
                        time: 15.5,
                        value: 1.0,
                        easing: "ease-in-out".into(),
                    },
                ],
            }],
        },
        Effect {
            id: "soften".into(),
            kind: EffectType::Blur,
            enabled: false,
            params: [("radius".into(), 8.0)].into_iter().collect(),
            animations: vec![],
        },
    ]
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
fn old_client_timeline_gets_empty_default_captions_and_effects() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let timeline = fixture(&conn);
    let mut value = serde_json::to_value(&timeline).unwrap();
    value.as_object_mut().unwrap().remove("captions");
    value["tracks"][0]["clips"][0]
        .as_object_mut()
        .unwrap()
        .remove("effects");
    let decoded: Timeline = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.captions, crate::captions::CaptionTrack::default());
    assert!(decoded.tracks[0].clips[0].effects.is_empty());
    assert_eq!(decoded, timeline);
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

#[test]
fn ordered_effect_edits_and_split_source_keyframes_survive_reopen() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("project.db");
    let conn = open_project_db(&path).unwrap();
    let mut timeline = video_fixture(&conn);
    timeline.tracks[0].clips[0].effects = effect_stack();
    save(&conn, &timeline).unwrap();
    drop(conn);

    let conn = open_project_db(&path).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline.clone()));
    let left = &mut timeline.tracks[0].clips[0];
    left.effects[0].params.insert("brightness".into(), 0.85);
    left.effects[2].enabled = true;
    left.effects.reverse();
    let mut right = left.clone();
    right.id = "video-clip-right".into();
    right.source_start = 12.0;
    right.timeline_start = 4.0;
    left.source_end = 12.0;
    left.timeline_end = 4.0;
    // Split clips keep their effect IDs and the entire original source-time curve.
    timeline.tracks[0].clips.push(right);
    save(&conn, &timeline).unwrap();
    drop(conn);

    let conn = open_project_db(&path).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline.clone()));
    timeline.tracks[0].clips[0].effects.clear();
    timeline.tracks[0].clips[1].effects.remove(1);
    save(&conn, &timeline).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline));
}

#[test]
fn phase_five_database_migrates_without_changing_existing_edits() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("project.db");
    let mut conn = Connection::open(&path).unwrap();
    let migrations = &crate::db::project_schema::PROJECT_MIGRATIONS;
    crate::db::migrations::apply(&mut conn, &migrations[..3], "test").unwrap();
    let mut timeline = video_fixture(&conn);
    timeline.tracks[1].locked = true;
    timeline.tracks[1].muted = true;
    timeline.tracks[1].clips[0].enabled = false;
    // Seed the actual previous schema: the current save function requires effects_json.
    conn.execute(
        "INSERT INTO timelines (id, name, duration_sec, width, height, fps, hook_json, captions_json, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'before-upgrade', 'before-upgrade')",
        params![timeline.id, timeline.name, timeline.duration, timeline.width, timeline.height,
            timeline.fps, serde_json::to_string(&timeline.hook).unwrap(),
            serde_json::to_string(&timeline.captions).unwrap()],
    ).unwrap();
    for (index, track) in timeline.tracks.iter().enumerate() {
        conn.execute(
            "INSERT INTO tracks (id, timeline_id, kind, name, order_index, enabled, locked, muted, solo, volume)
             VALUES (?1, 'main', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![track.id, track.kind, track.name, index as i64, track.enabled,
                track.locked, track.muted, track.solo, track.volume],
        ).unwrap();
        for clip in &track.clips {
            conn.execute(
                "INSERT INTO timeline_clips (id, track_id, source_media_id, label, source_start, source_end,
                    timeline_start, timeline_end, speed, enabled, transform_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![clip.id, track.id, clip.source_media_id, clip.label, clip.source_start,
                    clip.source_end, clip.timeline_start, clip.timeline_end, clip.speed, clip.enabled,
                    serde_json::to_string(&clip.transform).unwrap()],
            ).unwrap();
        }
    }
    assert!(conn
        .prepare("SELECT effects_json FROM timeline_clips")
        .is_err());
    let original_media = media::get_asset(&conn, "video-media").unwrap();
    drop(conn);

    let conn = open_project_db(&path).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline.clone()));
    assert_eq!(
        media::get_asset(&conn, "video-media").unwrap(),
        original_media
    );
    let updated_at: String = conn
        .query_row("SELECT updated_at FROM timelines", [], |row| row.get(0))
        .unwrap();
    assert_eq!(updated_at, "before-upgrade");
    timeline.tracks[0].clips[0].effects = effect_stack();
    save(&conn, &timeline).unwrap();
    drop(conn);

    // Reapplying migrations on reopen must also preserve effects added after the upgrade.
    let conn = open_project_db(&path).unwrap();
    assert_eq!(load(&conn).unwrap(), Some(timeline));
}

#[test]
fn invalid_effect_edits_preserve_the_previous_timeline() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let mut original = video_fixture(&conn);
    original.tracks[0].clips[0].effects = effect_stack();
    save(&conn, &original).unwrap();

    let mut bad_parameter = original.clone();
    bad_parameter.name = "Unsaved edit".into();
    bad_parameter.tracks[0].clips[0].effects[2]
        .params
        .insert("radius".into(), -1.0);
    let mut duplicate = original.clone();
    duplicate.tracks[0].clips[0].effects[2].id = "grade".into();
    let mut bad_keyframe = original.clone();
    bad_keyframe.tracks[0].clips[0].effects[1].animations[0].keyframes[1].time = 9.5;
    let mut audio_effect = original.clone();
    audio_effect.tracks[1].clips[0].effects = effect_stack();
    for invalid in [bad_parameter, duplicate, bad_keyframe, audio_effect] {
        assert!(save(&conn, &invalid).is_err());
        assert_eq!(load(&conn).unwrap(), Some(original.clone()));
    }
}

#[test]
fn failed_effect_write_rolls_back_other_edits_and_deleted_clips() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let mut original = video_fixture(&conn);
    original.tracks[0].clips[0].effects = effect_stack();
    save(&conn, &original).unwrap();
    conn.execute_batch(
        "CREATE TEMP TRIGGER reject_effect_update BEFORE UPDATE OF effects_json ON timeline_clips
         WHEN NEW.id = 'video-clip'
         BEGIN SELECT RAISE(ABORT, 'simulated effect write failure'); END;",
    )
    .unwrap();
    let mut edited = original.clone();
    edited.name = "Unsaved edit".into();
    edited.captions.style.font_size = 80.0;
    edited.tracks[0].clips[0].effects.reverse();
    edited.tracks[1].clips.clear();
    edited.tracks.reverse();
    let error = save(&conn, &edited).unwrap_err();
    assert!(error.to_string().contains("simulated effect write failure"));
    assert_eq!(load(&conn).unwrap(), Some(original));
}

#[test]
fn corrupt_or_invalid_persisted_effects_are_rejected_on_load() {
    let conn = crate::db::open_project_db_in_memory().unwrap();
    let mut timeline = video_fixture(&conn);
    timeline.tracks[0].clips[0].effects = effect_stack();
    save(&conn, &timeline).unwrap();
    let mut invalid_parameter = serde_json::to_value(effect_stack()).unwrap();
    invalid_parameter[2]["params"]["radius"] = (-1.0).into();
    let mut invalid_keyframe = serde_json::to_value(effect_stack()).unwrap();
    invalid_keyframe[1]["animations"][0]["keyframes"][0]["time"] = (-1.0).into();
    let mut unknown_type = serde_json::to_value(effect_stack()).unwrap();
    unknown_type[0]["type"] = "unsupported".into();
    for json in [
        "not json".to_owned(),
        "null".to_owned(),
        "{}".to_owned(),
        invalid_parameter.to_string(),
        invalid_keyframe.to_string(),
        unknown_type.to_string(),
    ] {
        conn.execute(
            "UPDATE timeline_clips SET effects_json = ?1 WHERE id = 'video-clip'",
            [json],
        )
        .unwrap();
        assert!(load(&conn).is_err());
    }
}
