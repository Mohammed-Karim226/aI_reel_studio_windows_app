//! Word timing and presentation persisted as part of the editable timeline.
use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::{error::AppResult, timeline::invalid};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionWord {
    pub text: String,
    pub start: f64,
    pub end: f64,
    #[serde(default)]
    pub emphasis: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionSegment {
    pub id: String,
    pub start: f64,
    pub end: f64,
    pub words: Vec<CaptionWord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionStyle {
    pub preset: String,
    pub font_family: String,
    pub font_size: f64,
    pub font_weight: u32,
    pub color: String,
    pub highlight_color: String,
    pub outline_color: String,
    pub outline_width: f64,
    pub shadow: bool,
    pub background: String,
    pub x: f64,
    pub y: f64,
    pub line_height: f64,
    pub max_width: f64,
    pub direction: String,
    pub animation: String,
    pub highlighting: String,
}

impl Default for CaptionStyle {
    fn default() -> Self {
        Self {
            preset: "classic".into(),
            font_family: "Arial".into(),
            font_size: 64.0,
            font_weight: 700,
            color: "#ffffff".into(),
            highlight_color: "#fbbf24".into(),
            outline_color: "#000000".into(),
            outline_width: 2.0,
            shadow: true,
            background: "transparent".into(),
            x: 50.0,
            y: 78.0,
            line_height: 1.2,
            max_width: 86.0,
            direction: "auto".into(),
            animation: "none".into(),
            highlighting: "none".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptionTrack {
    pub enabled: bool,
    pub style: CaptionStyle,
    pub segments: Vec<CaptionSegment>,
}

impl Default for CaptionTrack {
    fn default() -> Self {
        Self {
            enabled: true,
            style: CaptionStyle::default(),
            segments: vec![],
        }
    }
}

fn color(value: &str) -> bool {
    value.starts_with('#')
        && [4, 5, 7, 9].contains(&value.len())
        && value[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

impl CaptionTrack {
    pub fn validate(&self) -> AppResult<()> {
        let style = &self.style;
        if self.segments.len() > 10_000
            || ![
                "classic",
                "bold",
                "karaoke",
                "highlight",
                "minimal",
                "podcast",
                "impact",
                "dynamic",
                "arabic",
            ]
            .contains(&style.preset.as_str())
            || style.font_family.trim().is_empty()
            || style.font_family.chars().count() > 128
            || ![
                style.font_size,
                style.outline_width,
                style.x,
                style.y,
                style.line_height,
                style.max_width,
            ]
            .iter()
            .all(|n| n.is_finite())
            || !(10.0..=200.0).contains(&style.font_size)
            || ![400, 700, 900].contains(&style.font_weight)
            || !color(&style.color)
            || !color(&style.highlight_color)
            || !color(&style.outline_color)
            || !(style.background == "transparent" || color(&style.background))
            || !(0.0..=12.0).contains(&style.outline_width)
            || !(0.0..=100.0).contains(&style.x)
            || !(0.0..=100.0).contains(&style.y)
            || !(0.8..=2.0).contains(&style.line_height)
            || !(10.0..=100.0).contains(&style.max_width)
            || !["auto", "ltr", "rtl"].contains(&style.direction.as_str())
            || !["none", "fade", "pop"].contains(&style.animation.as_str())
            || !["none", "word", "karaoke"].contains(&style.highlighting.as_str())
        {
            return Err(invalid(
                "invalid caption style or too many caption segments",
            ));
        }
        let mut ids = HashSet::new();
        let mut previous_end = 0.0;
        for segment in &self.segments {
            if segment.id.is_empty()
                || segment.id.len() > 128
                || !ids.insert(&segment.id)
                || !segment.start.is_finite()
                || !segment.end.is_finite()
                || segment.start < 0.0
                || segment.start < previous_end - 0.00001
                || segment.end <= segment.start
                || segment.words.is_empty()
                || segment.words.len() > 100
            {
                return Err(invalid(
                    "invalid, overlapping, or unordered caption segment",
                ));
            }
            validate_words(&segment.words, segment.start, segment.end)?;
            previous_end = segment.end;
        }
        // Captions remain editable after media trims; they never extend the media duration.
        Ok(())
    }
}

pub fn validate_words(words: &[CaptionWord], start: f64, end: f64) -> AppResult<()> {
    let mut previous_start = 0.0;
    for word in words {
        if word.text.is_empty()
            || word.text.trim() != word.text
            || word.text.chars().count() > 512
            || !word.start.is_finite()
            || !word.end.is_finite()
            || word.start < 0.0
            || word.start < start - 0.00001
            || word.start < previous_start
            || word.end <= word.start
            || word.end > end + 0.00001
        {
            return Err(invalid("invalid caption word text or timestamps"));
        }
        previous_start = word.start;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn sample() -> CaptionTrack {
        CaptionTrack {
            segments: vec![CaptionSegment {
                id: "caption-1".into(),
                start: 1.0,
                end: 2.0,
                words: vec![CaptionWord {
                    text: "مرحبا".into(),
                    start: 1.0,
                    end: 1.5,
                    emphasis: true,
                }],
            }],
            ..Default::default()
        }
    }

    #[test]
    fn arabic_words_style_and_emphasis_round_trip() {
        let mut track = sample();
        track.style.direction = "rtl".into();
        track.validate().unwrap();
        assert_eq!(
            serde_json::from_str::<CaptionTrack>(&serde_json::to_string(&track).unwrap()).unwrap(),
            track
        );
    }

    #[test]
    fn rejects_overlap_duplicate_ids_and_unordered_segments() {
        let original = sample();
        let mut track = original.clone();
        track.segments.push(track.segments[0].clone());
        assert!(track.validate().is_err());
        track.segments[1].id = "caption-2".into();
        assert!(track.validate().is_err());
        track.segments[1].start = 0.0;
        assert!(track.validate().is_err());
    }

    #[test]
    fn rejects_invalid_word_times_and_untrimmed_text() {
        for word in [
            CaptionWord {
                start: 0.0,
                ..sample().segments[0].words[0].clone()
            },
            CaptionWord {
                end: 3.0,
                ..sample().segments[0].words[0].clone()
            },
            CaptionWord {
                end: f64::NAN,
                ..sample().segments[0].words[0].clone()
            },
            CaptionWord {
                text: "   ".into(),
                ..sample().segments[0].words[0].clone()
            },
        ] {
            let mut track = sample();
            track.segments[0].words[0] = word;
            assert!(track.validate().is_err());
        }
    }

    #[test]
    fn rejects_invalid_presentation_values() {
        let mut track = sample();
        track.style.font_size = f64::INFINITY;
        assert!(track.validate().is_err());
        track.style = CaptionStyle::default();
        track.style.color = "url(file://bad)".into();
        assert!(track.validate().is_err());
        track.style = CaptionStyle::default();
        track.style.direction = "sideways".into();
        assert!(track.validate().is_err());
    }

    #[test]
    fn missing_word_emphasis_defaults_to_false() {
        let word: CaptionWord =
            serde_json::from_str(r#"{"text":"Hello","start":0,"end":1}"#).unwrap();
        assert!(!word.emphasis);
    }

    #[test]
    fn timestamp_rounding_uses_the_frontend_tolerance() {
        let mut track = sample();
        track.segments[0].words[0].start = 1.0 - 0.000001;
        track.segments[0].words[0].end = 2.0 + 0.000001;
        let mut second = track.segments[0].clone();
        second.id = "caption-2".into();
        second.start = 2.0 - 0.000001;
        second.end = 3.0;
        second.words[0].start = 2.0;
        second.words[0].end = 2.5;
        track.segments.push(second);
        track.validate().unwrap();
        track.segments[1].start = 1.99;
        assert!(track.validate().is_err());
    }

    #[test]
    fn word_start_order_is_strict_even_inside_the_segment_tolerance() {
        let mut track = sample();
        let mut second = track.segments[0].words[0].clone();
        second.start -= 0.000001;
        track.segments[0].words.push(second);
        assert!(track.validate().is_err());
    }
}
