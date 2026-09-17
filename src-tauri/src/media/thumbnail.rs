use std::ffi::OsString;
use std::path::Path;

use crate::error::AppResult;
use crate::media::ffmpeg::FfmpegTools;
use crate::media::runner::{args, push_path, run_to_completion};

/// Poster frame height in the media library list.
pub const DEFAULT_THUMBNAIL_HEIGHT: u32 = 180;
/// Number of frames in a timeline filmstrip.
pub const DEFAULT_FILMSTRIP_FRAMES: u32 = 40;
/// Height of each filmstrip frame; the timeline track is short, so these stay small.
pub const DEFAULT_FILMSTRIP_HEIGHT: u32 = 90;

/// Never request a scale larger than the source: upscaling a proxy-grade artifact wastes time
/// and produces a blurry image that looks like a bug.
fn clamp_height(requested: u32, source_display_height: u32) -> u32 {
    let ceiling = if source_display_height == 0 {
        requested
    } else {
        source_display_height
    };
    // Even heights only: yuv420p chroma subsampling requires it, and libx264 rejects odd values.
    let clamped = requested.min(ceiling).max(2);
    clamped - (clamped % 2)
}

/// Picks a representative frame time. The very first frame of a recording is often black or a
/// slate, so seek a little way in — but never past the end of a short clip.
pub fn pick_thumbnail_time(duration_sec: f64) -> f64 {
    if !duration_sec.is_finite() || duration_sec <= 0.0 {
        return 0.0;
    }
    (duration_sec * 0.1).min(10.0).min(duration_sec * 0.9)
}

/// `ffmpeg` arguments for a single-frame JPEG.
///
/// `-ss` is placed before `-i` on purpose: input seeking jumps via the container index instead of
/// decoding from the start, which is the difference between instant and minutes on a long file.
pub fn thumbnail_args(source: &Path, output: &Path, at_sec: f64, height: u32) -> Vec<OsString> {
    let mut arguments = args(["-y", "-hide_banner", "-v", "error", "-ss"]);
    arguments.push(OsString::from(format!("{at_sec:.3}")));
    arguments.push(OsString::from("-i"));
    push_path(&mut arguments, source);
    arguments.extend(args(["-frames:v", "1", "-vf"]));
    arguments.push(OsString::from(format!("scale=-2:{height}")));
    arguments.extend(args(["-q:v", "3", "-f", "mjpeg"]));
    push_path(&mut arguments, output);
    arguments
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilmstripPlan {
    pub frames: u32,
    pub height: u32,
    /// Sampling rate handed to the `fps` filter, in frames per second.
    pub rate: f64,
}

/// Works out how many frames a filmstrip can actually carry.
///
/// A three-second clip cannot supply forty distinct frames, so the count is capped at roughly one
/// frame per 250 ms of source. Returns `None` when there is no usable duration.
pub fn plan_filmstrip(duration_sec: f64, target_frames: u32, height: u32) -> Option<FilmstripPlan> {
    if !duration_sec.is_finite() || duration_sec <= 0.0 || target_frames == 0 {
        return None;
    }

    let affordable = (duration_sec * 4.0).floor().max(1.0);
    let frames = u32::try_from(affordable as u64)
        .unwrap_or(u32::MAX)
        .min(target_frames)
        .max(1);

    // Sample one extra frame's worth: the `tile` filter only emits a strip once it has received
    // every input, and integer rounding inside `fps` can otherwise leave it one frame short.
    let rate = f64::from(frames + 1) / duration_sec;

    Some(FilmstripPlan {
        frames,
        height,
        rate,
    })
}

/// `ffmpeg` arguments for a horizontal filmstrip: sample, scale, then tile into one image.
pub fn filmstrip_args(source: &Path, output: &Path, plan: FilmstripPlan) -> Vec<OsString> {
    let mut arguments = args(["-y", "-hide_banner", "-v", "error", "-i"]);
    push_path(&mut arguments, source);
    arguments.push(OsString::from("-vf"));
    arguments.push(OsString::from(format!(
        "fps={:.6},scale=-2:{},tile={}x1",
        plan.rate, plan.height, plan.frames
    )));
    arguments.extend(args(["-frames:v", "1", "-q:v", "4", "-f", "mjpeg"]));
    push_path(&mut arguments, output);
    arguments
}

/// Extracts the poster frame. Fast enough (a single seek and decode) that it needs no progress
/// reporting or cancellation.
pub fn generate_thumbnail(
    tools: &FfmpegTools,
    source: &Path,
    output: &Path,
    duration_sec: f64,
    requested_height: u32,
    source_display_height: u32,
) -> AppResult<u32> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let height = clamp_height(requested_height, source_display_height);
    let at_sec = pick_thumbnail_time(duration_sec);
    run_to_completion(
        tools.ffmpeg(),
        &thumbnail_args(source, output, at_sec, height),
        "ffmpeg",
    )?;
    Ok(height)
}

/// Renders the filmstrip used by the timeline. Decodes the whole file, so it is run as a job.
pub fn generate_filmstrip(
    tools: &FfmpegTools,
    source: &Path,
    output: &Path,
    plan: FilmstripPlan,
    source_display_height: u32,
) -> AppResult<FilmstripPlan> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let plan = FilmstripPlan {
        height: clamp_height(plan.height, source_display_height),
        ..plan
    };
    run_to_completion(
        tools.ffmpeg(),
        &filmstrip_args(source, output, plan),
        "ffmpeg",
    )?;
    Ok(plan)
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
    fn thumbnail_time_skips_the_opening_frames() {
        assert_eq!(pick_thumbnail_time(100.0), 10.0);
        assert!((pick_thumbnail_time(20.0) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn thumbnail_time_is_capped_for_long_recordings() {
        // A two-hour podcast should not seek twelve minutes in.
        assert_eq!(pick_thumbnail_time(7200.0), 10.0);
    }

    #[test]
    fn thumbnail_time_stays_inside_very_short_clips() {
        let at = pick_thumbnail_time(0.5);
        assert!(at < 0.5, "seek point {at} must fall inside the clip");
    }

    #[test]
    fn thumbnail_time_handles_unusable_durations() {
        assert_eq!(pick_thumbnail_time(0.0), 0.0);
        assert_eq!(pick_thumbnail_time(-5.0), 0.0);
        assert_eq!(pick_thumbnail_time(f64::NAN), 0.0);
    }

    #[test]
    fn thumbnail_args_seek_before_the_input() {
        let arguments = joined(&thumbnail_args(
            Path::new(r"D:\a.mp4"),
            Path::new(r"D:\out.jpg"),
            12.5,
            180,
        ));
        let seek = arguments.find("-ss").expect("seek flag");
        let input = arguments.find("-i").expect("input flag");
        assert!(seek < input, "input seeking must precede -i to stay fast");
        assert!(arguments.contains("12.500"));
        assert!(arguments.contains("scale=-2:180"));
        assert!(arguments.contains("-frames:v 1"));
    }

    #[test]
    fn requested_height_is_clamped_to_the_source() {
        assert_eq!(clamp_height(1080, 720), 720);
        assert_eq!(clamp_height(180, 1080), 180);
    }

    #[test]
    fn clamped_heights_are_always_even() {
        assert_eq!(clamp_height(181, 1080), 180);
        assert_eq!(clamp_height(721, 1080), 720);
    }

    #[test]
    fn an_unknown_source_height_does_not_collapse_the_request() {
        assert_eq!(clamp_height(180, 0), 180);
    }

    #[test]
    fn filmstrip_uses_the_full_frame_count_for_long_sources() {
        let plan = plan_filmstrip(3600.0, 40, 90).expect("plan");
        assert_eq!(plan.frames, 40);
        assert_eq!(plan.height, 90);
        assert!((plan.rate - 41.0 / 3600.0).abs() < 1e-12);
    }

    #[test]
    fn filmstrip_frame_count_shrinks_for_short_clips() {
        // Two seconds cannot carry forty distinct frames.
        let plan = plan_filmstrip(2.0, 40, 90).expect("plan");
        assert_eq!(plan.frames, 8);
    }

    #[test]
    fn filmstrip_always_keeps_at_least_one_frame() {
        let plan = plan_filmstrip(0.1, 40, 90).expect("plan");
        assert_eq!(plan.frames, 1);
    }

    #[test]
    fn filmstrip_rate_oversamples_so_the_tile_filter_completes() {
        let plan = plan_filmstrip(10.0, 10, 90).expect("plan");
        assert!(
            plan.rate * 10.0 > f64::from(plan.frames),
            "must sample more frames than the tile needs"
        );
    }

    #[test]
    fn filmstrip_rejects_unusable_durations() {
        assert!(plan_filmstrip(0.0, 40, 90).is_none());
        assert!(plan_filmstrip(f64::INFINITY, 40, 90).is_none());
        assert!(plan_filmstrip(10.0, 0, 90).is_none());
    }

    #[test]
    fn filmstrip_args_build_the_expected_filter_chain() {
        let plan = plan_filmstrip(100.0, 25, 90).expect("plan");
        let arguments = joined(&filmstrip_args(
            Path::new(r"D:\a.mp4"),
            Path::new(r"D:\strip.jpg"),
            plan,
        ));
        assert!(arguments.contains("scale=-2:90"));
        assert!(arguments.contains("tile=25x1"));
        assert!(arguments.contains("fps=0.260000"));
    }

    #[test]
    fn paths_with_spaces_survive_argument_construction() {
        let arguments = thumbnail_args(
            Path::new(r"D:\my videos\ep 1.mp4"),
            Path::new(r"D:\out\ep 1.jpg"),
            1.0,
            180,
        );
        assert!(arguments.contains(&OsString::from(r"D:\my videos\ep 1.mp4")));
        assert!(arguments.contains(&OsString::from(r"D:\out\ep 1.jpg")));
    }
}
