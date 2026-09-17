use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MediaKind {
    Video,
    Audio,
    Image,
}

impl MediaKind {
    pub fn as_str(self) -> &'static str {
        match self {
            MediaKind::Video => "video",
            MediaKind::Audio => "audio",
            MediaKind::Image => "image",
        }
    }
}

impl fmt::Display for MediaKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for MediaKind {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "video" => Ok(MediaKind::Video),
            "audio" => Ok(MediaKind::Audio),
            "image" => Ok(MediaKind::Image),
            other => Err(AppError::UnsupportedMedia(format!(
                "unknown media kind `{other}`"
            ))),
        }
    }
}

/// Derived artifacts generated from a source asset. None of these are ever used for a final
/// export unless the user explicitly opts in (spec §4.3, §21).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DerivativeKind {
    Thumbnail,
    Filmstrip,
    Waveform,
    Proxy,
}

impl DerivativeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DerivativeKind::Thumbnail => "thumbnail",
            DerivativeKind::Filmstrip => "filmstrip",
            DerivativeKind::Waveform => "waveform",
            DerivativeKind::Proxy => "proxy",
        }
    }
}

impl fmt::Display for DerivativeKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for DerivativeKind {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "thumbnail" => Ok(DerivativeKind::Thumbnail),
            "filmstrip" => Ok(DerivativeKind::Filmstrip),
            "waveform" => Ok(DerivativeKind::Waveform),
            "proxy" => Ok(DerivativeKind::Proxy),
            other => Err(AppError::InvalidInput(format!(
                "unknown derivative kind `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DerivativeStatus {
    Pending,
    Running,
    Ready,
    Failed,
}

impl DerivativeStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            DerivativeStatus::Pending => "pending",
            DerivativeStatus::Running => "running",
            DerivativeStatus::Ready => "ready",
            DerivativeStatus::Failed => "failed",
        }
    }
}

impl FromStr for DerivativeStatus {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(DerivativeStatus::Pending),
            "running" => Ok(DerivativeStatus::Running),
            "ready" => Ok(DerivativeStatus::Ready),
            "failed" => Ok(DerivativeStatus::Failed),
            other => Err(AppError::InvalidInput(format!(
                "unknown derivative status `{other}`"
            ))),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    pub codec: String,
    /// Coded dimensions, before any container rotation metadata is applied.
    pub width: u32,
    pub height: u32,
    /// Rotation-corrected dimensions — what the viewer actually sees. Always use these for
    /// aspect-ratio and reframing maths.
    pub display_width: u32,
    pub display_height: u32,
    pub fps: f64,
    pub rotation: i32,
    pub pix_fmt: Option<String>,
    pub bit_rate: Option<u64>,
}

impl VideoStreamInfo {
    pub fn aspect_ratio(&self) -> f64 {
        if self.display_height == 0 {
            return 0.0;
        }
        f64::from(self.display_width) / f64::from(self.display_height)
    }

    /// True when the source is wider than tall and therefore needs reframing for a 9:16
    /// composition (spec §17).
    pub fn needs_reframe_for_vertical(&self) -> bool {
        self.aspect_ratio() > 9.0 / 16.0
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub bit_rate: Option<u64>,
}

/// Everything `ffprobe` told us about a file, normalized.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaMetadata {
    pub kind: MediaKind,
    pub container: Option<String>,
    pub duration_sec: f64,
    pub size_bytes: u64,
    pub video: Option<VideoStreamInfo>,
    pub audio: Option<AudioStreamInfo>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaDerivative {
    pub id: String,
    pub media_asset_id: String,
    pub kind: DerivativeKind,
    pub status: DerivativeStatus,
    /// Relative to the project root, so a project directory can be moved or copied.
    pub relative_path: Option<String>,
    pub params: serde_json::Value,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaAsset {
    pub id: String,
    /// Absolute path to the untouched source file. Never written to (spec §4.2).
    pub original_path: String,
    pub file_name: String,
    pub kind: MediaKind,
    pub container: Option<String>,
    pub size_bytes: u64,
    pub duration_sec: f64,
    pub has_video: bool,
    pub has_audio: bool,
    pub video: Option<VideoStreamInfo>,
    pub audio: Option<AudioStreamInfo>,
    pub imported_at: String,
    pub derivatives: Vec<MediaDerivative>,
}

impl MediaAsset {
    pub fn derivative(&self, kind: DerivativeKind) -> Option<&MediaDerivative> {
        self.derivatives.iter().find(|d| d.kind == kind)
    }

    pub fn has_ready_derivative(&self, kind: DerivativeKind) -> bool {
        self.derivative(kind)
            .is_some_and(|d| d.status == DerivativeStatus::Ready)
    }

    /// Rebuilds the probed metadata without touching the source file, so planning (which
    /// derivatives still apply, and at what size) works on a reopened project.
    pub fn metadata(&self) -> MediaMetadata {
        MediaMetadata {
            kind: self.kind,
            container: self.container.clone(),
            duration_sec: self.duration_sec,
            size_bytes: self.size_bytes,
            video: self.video.clone(),
            audio: self.audio.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn landscape() -> VideoStreamInfo {
        VideoStreamInfo {
            codec: "h264".into(),
            width: 1920,
            height: 1080,
            display_width: 1920,
            display_height: 1080,
            fps: 30.0,
            rotation: 0,
            pix_fmt: Some("yuv420p".into()),
            bit_rate: Some(8_000_000),
        }
    }

    #[test]
    fn media_kind_round_trips_through_text() {
        for kind in [MediaKind::Video, MediaKind::Audio, MediaKind::Image] {
            assert_eq!(MediaKind::from_str(kind.as_str()).expect("parse"), kind);
        }
    }

    #[test]
    fn unknown_media_kind_is_rejected() {
        let error = MediaKind::from_str("hologram").expect_err("unknown kind");
        assert_eq!(error.kind(), "unsupported_media");
    }

    #[test]
    fn derivative_kind_round_trips_through_text() {
        for kind in [
            DerivativeKind::Thumbnail,
            DerivativeKind::Filmstrip,
            DerivativeKind::Waveform,
            DerivativeKind::Proxy,
        ] {
            assert_eq!(
                DerivativeKind::from_str(kind.as_str()).expect("parse"),
                kind
            );
        }
    }

    #[test]
    fn derivative_status_round_trips_through_text() {
        for status in [
            DerivativeStatus::Pending,
            DerivativeStatus::Running,
            DerivativeStatus::Ready,
            DerivativeStatus::Failed,
        ] {
            assert_eq!(
                DerivativeStatus::from_str(status.as_str()).expect("parse"),
                status
            );
        }
    }

    #[test]
    fn landscape_sources_need_reframing_for_vertical() {
        assert!(landscape().needs_reframe_for_vertical());
    }

    #[test]
    fn native_vertical_sources_do_not_need_reframing() {
        let vertical = VideoStreamInfo {
            width: 1080,
            height: 1920,
            display_width: 1080,
            display_height: 1920,
            ..landscape()
        };
        assert!(!vertical.needs_reframe_for_vertical());
    }

    #[test]
    fn rotation_corrected_dimensions_drive_the_aspect_ratio() {
        // A phone video coded as 1920x1080 with a 90 degree rotation flag is really vertical.
        let rotated = VideoStreamInfo {
            width: 1920,
            height: 1080,
            display_width: 1080,
            display_height: 1920,
            rotation: 90,
            ..landscape()
        };
        assert!((rotated.aspect_ratio() - 0.5625).abs() < 1e-9);
        assert!(!rotated.needs_reframe_for_vertical());
    }

    #[test]
    fn zero_height_does_not_divide_by_zero() {
        let broken = VideoStreamInfo {
            display_height: 0,
            ..landscape()
        };
        assert_eq!(broken.aspect_ratio(), 0.0);
    }

    #[test]
    fn asset_reports_ready_derivatives() {
        let derivative = MediaDerivative {
            id: "d1".into(),
            media_asset_id: "m1".into(),
            kind: DerivativeKind::Proxy,
            status: DerivativeStatus::Ready,
            relative_path: Some("proxies/m1.mp4".into()),
            params: serde_json::json!({ "height": 720 }),
            error: None,
            created_at: "2026-01-01T00:00:00+00:00".into(),
            updated_at: "2026-01-01T00:00:00+00:00".into(),
        };
        let asset = MediaAsset {
            id: "m1".into(),
            original_path: r"D:\video.mp4".into(),
            file_name: "video.mp4".into(),
            kind: MediaKind::Video,
            container: Some("mov,mp4,m4a".into()),
            size_bytes: 1024,
            duration_sec: 60.0,
            has_video: true,
            has_audio: true,
            video: Some(landscape()),
            audio: None,
            imported_at: "2026-01-01T00:00:00+00:00".into(),
            derivatives: vec![derivative],
        };

        assert!(asset.has_ready_derivative(DerivativeKind::Proxy));
        assert!(!asset.has_ready_derivative(DerivativeKind::Waveform));
        assert!(asset.derivative(DerivativeKind::Thumbnail).is_none());
    }
}
