use std::path::Path;

use serde_json::json;

use crate::error::AppResult;
use crate::media::ffmpeg::FfmpegTools;
use crate::media::proxy::{self, ProxyPlan, DEFAULT_PROXY_HEIGHT};
use crate::media::runner::CancelToken;
use crate::media::thumbnail::{
    self, FilmstripPlan, DEFAULT_FILMSTRIP_FRAMES, DEFAULT_FILMSTRIP_HEIGHT,
    DEFAULT_THUMBNAIL_HEIGHT,
};
use crate::media::types::{DerivativeKind, MediaMetadata};
use crate::media::waveform::{self, DEFAULT_WAVEFORM_BUCKETS, WAVEFORM_SAMPLE_RATE};

/// Tunables for derivative generation, sourced from app settings.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DerivativeOptions {
    pub thumbnail_height: u32,
    pub filmstrip_frames: u32,
    pub filmstrip_height: u32,
    pub waveform_buckets: usize,
    pub proxy_height: u32,
}

impl Default for DerivativeOptions {
    fn default() -> Self {
        Self {
            thumbnail_height: DEFAULT_THUMBNAIL_HEIGHT,
            filmstrip_frames: DEFAULT_FILMSTRIP_FRAMES,
            filmstrip_height: DEFAULT_FILMSTRIP_HEIGHT,
            waveform_buckets: DEFAULT_WAVEFORM_BUCKETS,
            proxy_height: DEFAULT_PROXY_HEIGHT,
        }
    }
}

/// What, concretely, will be generated for one derivative request.
///
/// Deciding this up front and separately from running ffmpeg means every "should we even do
/// this?" rule is unit-testable without a media file.
#[derive(Debug, Clone, PartialEq)]
pub enum DerivativePlan {
    Thumbnail {
        height: u32,
        at_sec: f64,
    },
    Filmstrip(FilmstripPlan),
    Waveform {
        buckets: usize,
    },
    Proxy(ProxyPlan),
    /// The derivative makes no sense for this asset. Not an error: a silent screen recording
    /// genuinely has no waveform, and the UI must show that as "not applicable", not "failed".
    NotApplicable {
        reason: &'static str,
    },
}

/// Works out the concrete plan for a derivative, or why it does not apply.
pub fn plan(
    kind: DerivativeKind,
    metadata: &MediaMetadata,
    options: DerivativeOptions,
) -> DerivativePlan {
    match kind {
        DerivativeKind::Thumbnail => {
            if metadata.video.is_none() {
                return DerivativePlan::NotApplicable {
                    reason: "asset has no video stream",
                };
            }
            DerivativePlan::Thumbnail {
                height: options.thumbnail_height,
                at_sec: thumbnail::pick_thumbnail_time(metadata.duration_sec),
            }
        }
        DerivativeKind::Filmstrip => {
            if metadata.video.is_none() {
                return DerivativePlan::NotApplicable {
                    reason: "asset has no video stream",
                };
            }
            match thumbnail::plan_filmstrip(
                metadata.duration_sec,
                options.filmstrip_frames,
                options.filmstrip_height,
            ) {
                Some(plan) => DerivativePlan::Filmstrip(plan),
                None => DerivativePlan::NotApplicable {
                    reason: "asset has no usable duration",
                },
            }
        }
        DerivativeKind::Waveform => {
            if metadata.audio.is_none() {
                return DerivativePlan::NotApplicable {
                    reason: "asset has no audio stream",
                };
            }
            DerivativePlan::Waveform {
                buckets: options.waveform_buckets,
            }
        }
        DerivativeKind::Proxy => {
            let Some(video) = metadata.video.as_ref() else {
                return DerivativePlan::NotApplicable {
                    reason: "asset has no video stream",
                };
            };
            match proxy::plan_proxy(
                video.display_height,
                &video.codec,
                metadata.audio.is_some(),
                options.proxy_height,
            ) {
                Some(plan) => DerivativePlan::Proxy(plan),
                None => DerivativePlan::NotApplicable {
                    reason: "original is already cheap to play back",
                },
            }
        }
    }
}

/// Serialized description of a plan. Recorded while a derivative is still pending, and re-used
/// with the *applied* plan after a run so the stored parameters always describe the real artifact.
pub fn plan_params(plan: &DerivativePlan) -> serde_json::Value {
    match plan {
        DerivativePlan::NotApplicable { reason } => json!({ "notApplicable": reason }),
        DerivativePlan::Thumbnail { height, at_sec } => {
            json!({ "height": height, "atSec": at_sec })
        }
        DerivativePlan::Filmstrip(plan) => json!({
            "frames": plan.frames,
            "height": plan.height,
            "rate": plan.rate,
        }),
        DerivativePlan::Waveform { buckets } => json!({
            "buckets": buckets,
            "sampleRate": WAVEFORM_SAMPLE_RATE,
        }),
        DerivativePlan::Proxy(plan) => json!({
            "height": plan.height,
            "crf": plan.crf,
            "preset": plan.preset,
            "reason": plan.reason,
        }),
    }
}

/// Everything a derivative run produced.
#[derive(Debug, Clone, PartialEq)]
pub struct DerivativeOutput {
    /// `false` when the derivative did not apply; no file was written.
    pub produced: bool,
    /// Recorded alongside the derivative row so a later run can tell whether the parameters
    /// changed and the artifact needs rebuilding.
    pub params: serde_json::Value,
}

/// One derivative request. Collected into a struct so the trait signature stays readable and a
/// future engine can take extra knobs without breaking every caller.
#[derive(Debug, Clone, Copy)]
pub struct DerivativeRequest<'a> {
    pub kind: DerivativeKind,
    pub source: &'a Path,
    pub output: &'a Path,
    pub metadata: &'a MediaMetadata,
    pub options: DerivativeOptions,
}

/// Generates the derived artifacts the editor needs to feel fast.
///
/// Callers depend on this trait, not on ffmpeg, so a future engine can replace the implementation
/// without touching them.
pub trait MediaDeriver: Send + Sync {
    fn derive(
        &self,
        request: &DerivativeRequest<'_>,
        cancel: &CancelToken,
        on_progress: &mut dyn FnMut(f64),
    ) -> AppResult<DerivativeOutput>;
}

/// The ffmpeg-backed implementation. FFmpeg runs as an external process and is never bundled in
/// v1 (spec §34), so this type is constructed only once a working installation is resolved.
#[derive(Debug, Clone)]
pub struct FfmpegEngine {
    tools: FfmpegTools,
}

impl FfmpegEngine {
    pub fn new(tools: FfmpegTools) -> Self {
        Self { tools }
    }

    pub fn tools(&self) -> &FfmpegTools {
        &self.tools
    }
}

impl MediaDeriver for FfmpegEngine {
    fn derive(
        &self,
        request: &DerivativeRequest<'_>,
        cancel: &CancelToken,
        on_progress: &mut dyn FnMut(f64),
    ) -> AppResult<DerivativeOutput> {
        let DerivativeRequest {
            kind,
            source,
            output,
            metadata,
            options,
        } = *request;

        let display_height = metadata
            .video
            .as_ref()
            .map_or(0, |video| video.display_height);

        match plan(kind, metadata, options) {
            DerivativePlan::NotApplicable { reason } => Ok(DerivativeOutput {
                produced: false,
                params: plan_params(&DerivativePlan::NotApplicable { reason }),
            }),

            DerivativePlan::Thumbnail { height, at_sec } => {
                let height = thumbnail::generate_thumbnail(
                    &self.tools,
                    source,
                    output,
                    metadata.duration_sec,
                    height,
                    display_height,
                )?;
                on_progress(1.0);
                Ok(DerivativeOutput {
                    produced: true,
                    params: plan_params(&DerivativePlan::Thumbnail { height, at_sec }),
                })
            }

            DerivativePlan::Filmstrip(requested) => {
                let applied = thumbnail::generate_filmstrip(
                    &self.tools,
                    source,
                    output,
                    requested,
                    display_height,
                )?;
                on_progress(1.0);
                Ok(DerivativeOutput {
                    produced: true,
                    params: plan_params(&DerivativePlan::Filmstrip(applied)),
                })
            }

            DerivativePlan::Waveform { buckets } => {
                let data = waveform::generate_waveform(
                    &self.tools,
                    source,
                    output,
                    metadata.duration_sec,
                    buckets,
                    cancel,
                    on_progress,
                )?;
                Ok(DerivativeOutput {
                    produced: true,
                    params: plan_params(&DerivativePlan::Waveform {
                        buckets: data.peaks.len(),
                    }),
                })
            }

            DerivativePlan::Proxy(proxy_plan) => {
                proxy::generate_proxy(
                    &self.tools,
                    source,
                    output,
                    metadata.duration_sec,
                    proxy_plan,
                    cancel,
                    on_progress,
                )?;
                Ok(DerivativeOutput {
                    produced: true,
                    params: plan_params(&DerivativePlan::Proxy(proxy_plan)),
                })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::types::{AudioStreamInfo, MediaKind, VideoStreamInfo};

    fn video_metadata() -> MediaMetadata {
        MediaMetadata {
            kind: MediaKind::Video,
            container: Some("mov,mp4".into()),
            duration_sec: 3600.0,
            size_bytes: 4_000_000_000,
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

    fn silent_video() -> MediaMetadata {
        MediaMetadata {
            audio: None,
            ..video_metadata()
        }
    }

    fn audio_only() -> MediaMetadata {
        MediaMetadata {
            kind: MediaKind::Audio,
            video: None,
            duration_sec: 600.0,
            ..video_metadata()
        }
    }

    #[test]
    fn a_4k_video_plans_all_four_derivatives() {
        let metadata = video_metadata();
        let options = DerivativeOptions::default();

        for kind in [
            DerivativeKind::Thumbnail,
            DerivativeKind::Filmstrip,
            DerivativeKind::Waveform,
            DerivativeKind::Proxy,
        ] {
            assert!(
                !matches!(
                    plan(kind, &metadata, options),
                    DerivativePlan::NotApplicable { .. }
                ),
                "{kind} should be planned for a 4K video"
            );
        }
    }

    #[test]
    fn a_silent_video_has_no_waveform_but_is_not_a_failure() {
        let plan = plan(
            DerivativeKind::Waveform,
            &silent_video(),
            DerivativeOptions::default(),
        );
        assert!(matches!(plan, DerivativePlan::NotApplicable { .. }));
    }

    #[test]
    fn an_audio_file_has_no_visual_derivatives() {
        let metadata = audio_only();
        let options = DerivativeOptions::default();

        for kind in [
            DerivativeKind::Thumbnail,
            DerivativeKind::Filmstrip,
            DerivativeKind::Proxy,
        ] {
            assert!(
                matches!(
                    plan(kind, &metadata, options),
                    DerivativePlan::NotApplicable { .. }
                ),
                "{kind} must not be planned for an audio-only asset"
            );
        }

        assert!(matches!(
            plan(DerivativeKind::Waveform, &metadata, options),
            DerivativePlan::Waveform { .. }
        ));
    }

    #[test]
    fn thumbnail_plan_carries_the_seek_point() {
        let DerivativePlan::Thumbnail { height, at_sec } = plan(
            DerivativeKind::Thumbnail,
            &video_metadata(),
            DerivativeOptions::default(),
        ) else {
            panic!("expected a thumbnail plan");
        };
        assert_eq!(height, DEFAULT_THUMBNAIL_HEIGHT);
        assert_eq!(at_sec, 10.0);
    }

    #[test]
    fn a_small_h264_source_skips_the_proxy() {
        let metadata = MediaMetadata {
            video: Some(VideoStreamInfo {
                display_height: 720,
                display_width: 1280,
                ..video_metadata().video.expect("video")
            }),
            ..video_metadata()
        };

        assert!(matches!(
            plan(
                DerivativeKind::Proxy,
                &metadata,
                DerivativeOptions::default()
            ),
            DerivativePlan::NotApplicable { .. }
        ));
    }

    #[test]
    fn a_zero_duration_asset_skips_the_filmstrip() {
        let metadata = MediaMetadata {
            duration_sec: 0.0,
            ..video_metadata()
        };
        assert!(matches!(
            plan(
                DerivativeKind::Filmstrip,
                &metadata,
                DerivativeOptions::default()
            ),
            DerivativePlan::NotApplicable { .. }
        ));
    }

    #[test]
    fn options_flow_into_the_plan() {
        let options = DerivativeOptions {
            proxy_height: 480,
            waveform_buckets: 500,
            ..DerivativeOptions::default()
        };

        let DerivativePlan::Proxy(proxy_plan) =
            plan(DerivativeKind::Proxy, &video_metadata(), options)
        else {
            panic!("expected a proxy plan");
        };
        assert_eq!(proxy_plan.height, 480);

        let DerivativePlan::Waveform { buckets } =
            plan(DerivativeKind::Waveform, &video_metadata(), options)
        else {
            panic!("expected a waveform plan");
        };
        assert_eq!(buckets, 500);
    }

    #[test]
    fn default_options_match_the_published_constants() {
        let options = DerivativeOptions::default();
        assert_eq!(options.proxy_height, 720);
        assert_eq!(options.waveform_buckets, 2_000);
        assert_eq!(options.filmstrip_frames, 40);
    }

    #[test]
    fn plan_params_describe_the_planned_artifact() {
        let options = DerivativeOptions::default();

        let DerivativePlan::Proxy(proxy_plan) =
            plan(DerivativeKind::Proxy, &video_metadata(), options)
        else {
            panic!("expected a proxy plan");
        };
        let params = plan_params(&DerivativePlan::Proxy(proxy_plan));
        assert_eq!(params["height"], 720);
        assert_eq!(params["crf"], 23);
        assert_eq!(params["reason"], "resolution");
    }

    #[test]
    fn plan_params_render_a_not_applicable_reason() {
        let params = plan_params(&DerivativePlan::NotApplicable {
            reason: "asset has no audio stream",
        });
        assert_eq!(params["notApplicable"], "asset has no audio stream");
    }
}
