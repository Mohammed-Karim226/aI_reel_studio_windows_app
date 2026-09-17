use std::ffi::OsString;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::media::ffmpeg::FfmpegTools;
use crate::media::runner::{args, push_path, run_with_progress, CancelToken};

/// Default proxy height. 720p is small enough to scrub in a WebView yet large enough that the
/// preview still reads as the finished frame.
pub const DEFAULT_PROXY_HEIGHT: u32 = 720;
/// Constant-rate-factor for proxies. Editing copies do not need archival quality.
const PROXY_CRF: u32 = 23;
/// Preset trading a little file size for much faster generation.
const PROXY_PRESET: &str = "veryfast";
/// Keyframe interval in frames. A short GOP is the whole point of a proxy: scrubbing lands on a
/// keyframe instead of decoding a long chain of B-frames.
const PROXY_KEYFRAME_INTERVAL: u32 = 30;

/// Codecs that stay expensive to decode no matter how small the frame is, so a proxy is worth
/// building even for an already-small source.
const EXPENSIVE_CODECS: [&str; 8] = [
    "hevc",
    "h265",
    "av1",
    "vp9",
    "prores",
    "dnxhd",
    "mpeg2video",
    "mjpeg",
];

pub fn is_expensive_codec(codec: &str) -> bool {
    let codec = codec.trim().to_ascii_lowercase();
    EXPENSIVE_CODECS.contains(&codec.as_str())
}

/// Why a proxy is being built. Surfaced so the UI can explain itself instead of showing an
/// unexplained background job.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyReason {
    /// The source frame is larger than the editing target.
    Resolution,
    /// The frame is small enough, but the codec is costly to decode.
    Codec,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyPlan {
    pub height: u32,
    pub crf: u32,
    pub preset: &'static str,
    pub include_audio: bool,
    pub reason: ProxyReason,
}

/// Decides whether a proxy is worth generating, and at what size.
///
/// Returns `None` when the original is already cheap to play, because a proxy that is not smaller
/// or simpler than its source only costs disk and time. Proxies are never used for final export
/// unless the user explicitly asks (spec §4.3, §21).
pub fn plan_proxy(
    display_height: u32,
    codec: &str,
    has_audio: bool,
    target_height: u32,
) -> Option<ProxyPlan> {
    let target_height = target_height.max(2);
    let target_height = target_height - (target_height % 2);

    let reason = if display_height > target_height {
        ProxyReason::Resolution
    } else if is_expensive_codec(codec) {
        ProxyReason::Codec
    } else {
        return None;
    };

    // Never upscale: for an expensive codec at a small size, re-encode at the source height.
    let height = if display_height == 0 {
        target_height
    } else {
        display_height.min(target_height)
    };
    let height = height.max(2);

    Some(ProxyPlan {
        height: height - (height % 2),
        crf: PROXY_CRF,
        preset: PROXY_PRESET,
        include_audio: has_audio,
        reason,
    })
}

/// `ffmpeg` arguments for an H.264/AAC MP4 editing proxy.
pub fn proxy_args(source: &Path, output: &Path, plan: ProxyPlan) -> Vec<OsString> {
    let mut arguments = args(["-y", "-hide_banner", "-v", "error", "-nostdin", "-i"]);
    push_path(&mut arguments, source);

    arguments.extend(args(["-map", "0:v:0"]));
    if plan.include_audio {
        // The trailing `?` keeps the run alive if the stream turns out to be missing.
        arguments.extend(args(["-map", "0:a:0?"]));
    }
    // Subtitles and data streams cannot be carried into an H.264 MP4 proxy and only cause
    // "could not find tag" failures.
    arguments.extend(args(["-sn", "-dn"]));

    arguments.push(OsString::from("-vf"));
    arguments.push(OsString::from(format!("scale=-2:{}", plan.height)));

    arguments.extend(args(["-c:v", "libx264", "-preset"]));
    arguments.push(OsString::from(plan.preset));
    arguments.push(OsString::from("-crf"));
    arguments.push(OsString::from(plan.crf.to_string()));
    arguments.extend(args(["-pix_fmt", "yuv420p", "-g"]));
    arguments.push(OsString::from(PROXY_KEYFRAME_INTERVAL.to_string()));

    if plan.include_audio {
        arguments.extend(args(["-c:a", "aac", "-b:a", "128k", "-ac", "2"]));
    } else {
        arguments.push(OsString::from("-an"));
    }

    // `faststart` puts the index at the front so the WebView can begin playback immediately.
    arguments.extend(args(["-movflags", "+faststart", "-f", "mp4"]));
    push_path(&mut arguments, output);
    arguments
}

/// Transcodes an editing proxy, reporting progress and honouring cancellation.
pub fn generate_proxy(
    tools: &FfmpegTools,
    source: &Path,
    output: &Path,
    duration_sec: f64,
    plan: ProxyPlan,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(f64),
) -> AppResult<()> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    run_with_progress(
        tools.ffmpeg(),
        &proxy_args(source, output, plan),
        duration_sec,
        cancel,
        on_progress,
    )?;

    // A cancelled or crashed run can leave a truncated file that would play as a broken clip.
    if !output.is_file() {
        return Err(crate::error::AppError::Internal(format!(
            "ffmpeg reported success but {} was not written",
            output.display()
        )));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn joined(arguments: &[OsString]) -> String {
        arguments
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
    }

    #[test]
    fn a_4k_source_gets_a_720p_proxy() {
        let plan = plan_proxy(2160, "h264", true, 720).expect("plan");
        assert_eq!(plan.height, 720);
        assert_eq!(plan.reason, ProxyReason::Resolution);
        assert!(plan.include_audio);
    }

    #[test]
    fn an_already_small_h264_source_needs_no_proxy() {
        assert!(plan_proxy(720, "h264", true, 720).is_none());
        assert!(plan_proxy(480, "h264", true, 720).is_none());
    }

    #[test]
    fn an_expensive_codec_earns_a_proxy_even_at_a_small_size() {
        let plan = plan_proxy(540, "hevc", true, 720).expect("plan");
        assert_eq!(plan.reason, ProxyReason::Codec);
        // Must not upscale 540p to 720p.
        assert_eq!(plan.height, 540);
    }

    #[test]
    fn expensive_codec_detection_ignores_case_and_padding() {
        assert!(is_expensive_codec("HEVC"));
        assert!(is_expensive_codec(" av1 "));
        assert!(is_expensive_codec("prores"));
        assert!(!is_expensive_codec("h264"));
        assert!(!is_expensive_codec(""));
    }

    #[test]
    fn proxy_heights_are_always_even() {
        assert_eq!(
            plan_proxy(2160, "h264", true, 721).expect("plan").height,
            720
        );
        assert_eq!(
            plan_proxy(1081, "hevc", true, 2000).expect("plan").height,
            1080
        );
    }

    #[test]
    fn an_unknown_source_height_falls_back_to_the_target() {
        let plan = plan_proxy(0, "hevc", false, 720).expect("plan");
        assert_eq!(plan.height, 720);
    }

    #[test]
    fn a_silent_source_produces_a_silent_proxy() {
        let plan = plan_proxy(2160, "h264", false, 720).expect("plan");
        assert!(!plan.include_audio);

        let arguments = joined(&proxy_args(
            Path::new(r"D:\a.mp4"),
            Path::new(r"D:\p.mp4"),
            plan,
        ));
        assert!(arguments.contains("-an"));
        assert!(!arguments.contains("-c:a aac"));
        assert!(!arguments.contains("0:a:0"));
    }

    #[test]
    fn proxy_args_encode_h264_aac_with_a_short_gop() {
        let plan = plan_proxy(2160, "h264", true, 720).expect("plan");
        let arguments = joined(&proxy_args(
            Path::new(r"D:\a.mp4"),
            Path::new(r"D:\p.mp4"),
            plan,
        ));

        assert!(arguments.contains("-c:v libx264"));
        assert!(arguments.contains("-preset veryfast"));
        assert!(arguments.contains("-crf 23"));
        assert!(arguments.contains("scale=-2:720"));
        assert!(arguments.contains("-pix_fmt yuv420p"));
        assert!(arguments.contains("-g 30"));
        assert!(arguments.contains("-c:a aac"));
        assert!(arguments.contains("-movflags +faststart"));
    }

    #[test]
    fn proxy_args_drop_subtitle_and_data_streams() {
        let plan = plan_proxy(2160, "h264", true, 720).expect("plan");
        let arguments = joined(&proxy_args(
            Path::new(r"D:\a.mkv"),
            Path::new(r"D:\p.mp4"),
            plan,
        ));
        assert!(arguments.contains("-sn"));
        assert!(arguments.contains("-dn"));
    }

    #[test]
    fn the_optional_audio_map_tolerates_a_missing_stream() {
        let plan = plan_proxy(2160, "h264", true, 720).expect("plan");
        let arguments = joined(&proxy_args(
            Path::new(r"D:\a.mp4"),
            Path::new(r"D:\p.mp4"),
            plan,
        ));
        assert!(
            arguments.contains("0:a:0?"),
            "the audio map must be optional so a mis-probed file does not fail the whole proxy"
        );
    }

    #[test]
    fn output_path_is_the_final_argument() {
        let plan = plan_proxy(2160, "h264", true, 720).expect("plan");
        let arguments = proxy_args(Path::new(r"D:\a.mp4"), Path::new(r"D:\out\p.mp4"), plan);
        assert_eq!(
            arguments.last().expect("output"),
            &OsString::from(r"D:\out\p.mp4")
        );
    }
}
