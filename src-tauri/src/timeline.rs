//! Versioned edit decisions. Source files are referenced, never changed.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transform {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub opacity: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookKeyframe {
    pub time: f64,
    pub value: f64,
    pub easing: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookAnimation {
    pub property: String,
    pub keyframes: Vec<HookKeyframe>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookStyle {
    pub font_size: f64,
    pub color: String,
    pub background: String,
    pub weight: String,
    pub align: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HookLayer {
    pub id: String,
    pub role: String,
    pub text: String,
    pub start: f64,
    pub end: f64,
    pub style: HookStyle,
    pub transform: Transform,
    pub animations: Vec<HookAnimation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Hook {
    pub enabled: bool,
    pub duration: f64,
    pub background: String,
    pub layers: Vec<HookLayer>,
}

impl Default for Hook {
    fn default() -> Self {
        Self {
            enabled: true,
            duration: 1.5,
            background: "#111827".into(),
            layers: vec![],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Clip {
    pub id: String,
    pub source_media_id: String,
    pub label: String,
    pub source_start: f64,
    pub source_end: f64,
    pub timeline_start: f64,
    pub timeline_end: f64,
    pub speed: f64,
    pub enabled: bool,
    pub transform: Transform,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Track {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    pub locked: bool,
    pub muted: bool,
    pub solo: bool,
    pub volume: f64,
    pub clips: Vec<Clip>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Timeline {
    pub version: u32,
    pub id: String,
    pub name: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
    pub hook: Hook,
    pub tracks: Vec<Track>,
}

pub fn invalid(message: &str) -> AppError {
    AppError::InvalidInput(message.into())
}

impl Timeline {
    pub fn validate(&self) -> AppResult<()> {
        if self.version != 1
            || self.id != "main"
            || self.name.is_empty()
            || self.name.len() > 512
            || self.width == 0
            || self.height == 0
            || !self.fps.is_finite()
            || self.fps <= 0.0
            || self.fps > 240.0
            || !self.duration.is_finite()
            || self.duration < 0.0
            || self.tracks.len() > 64
            || !self.hook.duration.is_finite()
            || self.hook.duration < 0.0
            || self.hook.layers.len() > 32
        {
            return Err(invalid("invalid or unsupported timeline format"));
        }
        let mut ids = HashSet::new();
        for layer in &self.hook.layers {
            if layer.id.is_empty()
                || layer.id.len() > 128
                || !ids.insert(&layer.id)
                || !["main", "secondary"].contains(&layer.role.as_str())
                || layer.text.len() > 500
                || ![layer.start, layer.end, layer.style.font_size]
                    .iter()
                    .all(|value| value.is_finite())
                || layer.start < 0.0
                || layer.end <= layer.start
                || layer.end > self.hook.duration + 0.00001
                || layer.style.font_size <= 0.0
                || layer.style.color.is_empty()
                || layer.style.color.len() > 32
                || layer.style.background.len() > 32
                || !["regular", "bold", "black"].contains(&layer.style.weight.as_str())
                || !["left", "center", "right"].contains(&layer.style.align.as_str())
                || layer.animations.len() > 10
            {
                return Err(invalid("invalid hook layer"));
            }
            for animation in &layer.animations {
                if !["x", "y", "scale", "rotation", "opacity"]
                    .contains(&animation.property.as_str())
                    || animation.keyframes.is_empty()
                    || animation.keyframes.len() > 100
                {
                    return Err(invalid("invalid hook animation"));
                }
                let mut previous = -1.0;
                for keyframe in &animation.keyframes {
                    if !keyframe.time.is_finite()
                        || keyframe.time < 0.0
                        || !keyframe.value.is_finite()
                        || keyframe.time < previous
                        || !["linear", "ease-in", "ease-out", "ease-in-out"]
                            .contains(&keyframe.easing.as_str())
                    {
                        return Err(invalid("invalid hook keyframe"));
                    }
                    previous = keyframe.time;
                }
            }
        }
        let mut duration: f64 = 0.0;
        for track in &self.tracks {
            if track.id.is_empty()
                || track.id.len() > 128
                || !ids.insert(&track.id)
                || track.name.is_empty()
                || track.name.len() > 512
                || track.clips.len() > 10_000
                || !track.volume.is_finite()
                || !(0.0..=1.0).contains(&track.volume)
                || ![
                    "video", "audio", "text", "captions", "graphics", "effects", "sfx",
                ]
                .contains(&track.kind.as_str())
            {
                return Err(invalid("invalid track or duplicate ID"));
            }
            let mut clips: Vec<_> = track.clips.iter().collect();
            clips.sort_by(|a, b| a.timeline_start.total_cmp(&b.timeline_start));
            let mut end = 0.0;
            for clip in clips {
                let t = &clip.transform;
                if clip.id.is_empty()
                    || clip.id.len() > 128
                    || !ids.insert(&clip.id)
                    || clip.source_media_id.is_empty()
                    || clip.label.len() > 2048
                    || ![
                        clip.source_start,
                        clip.source_end,
                        clip.timeline_start,
                        clip.timeline_end,
                        t.x,
                        t.y,
                        t.scale,
                        t.rotation,
                        t.opacity,
                    ]
                    .iter()
                    .all(|n| n.is_finite())
                    || clip.source_start < 0.0
                    || clip.timeline_start < 0.0
                    || clip.source_end <= clip.source_start
                    || clip.timeline_end <= clip.timeline_start
                    || clip.speed != 1.0
                    || t.scale <= 0.0
                    || !(0.0..=1.0).contains(&t.opacity)
                    || ((clip.source_end - clip.source_start)
                        - (clip.timeline_end - clip.timeline_start))
                        .abs()
                        > 0.00001
                    || clip.timeline_start < end - 0.00001
                {
                    return Err(invalid(
                        "invalid clip, source timing, duplicate ID, or overlapping clips",
                    ));
                }
                end = clip.timeline_end;
                duration = duration.max(end);
            }
        }
        if (duration - self.duration).abs() > 0.00001 {
            return Err(invalid("timeline duration does not match its clips"));
        }
        Ok(())
    }
}
