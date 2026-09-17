use std::path::Path;

use serde_json::Value;
use tracing::debug;

use crate::error::{AppError, AppResult};
use crate::logging::category;
use crate::media::ffmpeg::FfmpegTools;
use crate::media::runner::command;
use crate::media::types::{AudioStreamInfo, MediaKind, MediaMetadata, VideoStreamInfo};

/// ffprobe emits numbers as JSON strings in most fields, but not all of them.
fn as_u64(value: Option<&Value>) -> Option<u64> {
    match value? {
        Value::Number(number) => number.as_u64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

fn as_u32(value: Option<&Value>) -> Option<u32> {
    as_u64(value).and_then(|n| u32::try_from(n).ok())
}

/// Parses ffprobe rational strings such as `30000/1001`. Returns `None` for the `0/0` that
/// ffprobe emits when a stream has no meaningful frame rate.
fn parse_rational(value: &str) -> Option<f64> {
    let (numerator, denominator) = value.split_once('/')?;
    let numerator: f64 = numerator.trim().parse().ok()?;
    let denominator: f64 = denominator.trim().parse().ok()?;
    if denominator == 0.0 || numerator == 0.0 {
        return None;
    }
    Some(numerator / denominator)
}

/// Rotation can arrive either as a Display Matrix side-data entry (modern ffprobe, signed
/// degrees) or as a legacy `tags.rotate` string. Normalized to 0/90/180/270.
fn parse_rotation(stream: &Value) -> i32 {
    let raw = stream
        .get("side_data_list")
        .and_then(Value::as_array)
        .and_then(|entries| {
            entries
                .iter()
                .find_map(|entry| as_f64(entry.get("rotation")))
        })
        .or_else(|| {
            stream
                .get("tags")
                .and_then(|tags| as_f64(tags.get("rotate")))
        })
        .unwrap_or(0.0);

    let normalized = raw.round() as i32;
    normalized.rem_euclid(360)
}

fn parse_video_stream(stream: &Value) -> Option<VideoStreamInfo> {
    let width = as_u32(stream.get("width"))?;
    let height = as_u32(stream.get("height"))?;
    let rotation = parse_rotation(stream);

    // A quarter turn swaps what the viewer sees; everything downstream (reframing, safe zones,
    // export sizing) must use the display dimensions, not the coded ones.
    let quarter_turn = rotation == 90 || rotation == 270;
    let (display_width, display_height) = if quarter_turn {
        (height, width)
    } else {
        (width, height)
    };

    let fps = stream
        .get("avg_frame_rate")
        .and_then(Value::as_str)
        .and_then(parse_rational)
        .or_else(|| {
            stream
                .get("r_frame_rate")
                .and_then(Value::as_str)
                .and_then(parse_rational)
        })
        .unwrap_or(0.0);

    Some(VideoStreamInfo {
        codec: stream
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        width,
        height,
        display_width,
        display_height,
        fps,
        rotation,
        pix_fmt: stream
            .get("pix_fmt")
            .and_then(Value::as_str)
            .map(str::to_string),
        bit_rate: as_u64(stream.get("bit_rate")),
    })
}

fn parse_audio_stream(stream: &Value) -> AudioStreamInfo {
    AudioStreamInfo {
        codec: stream
            .get("codec_name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        channels: as_u32(stream.get("channels")).unwrap_or(0),
        sample_rate: as_u32(stream.get("sample_rate")).unwrap_or(0),
        bit_rate: as_u64(stream.get("bit_rate")),
    }
}

/// Container formats that mean "this is a still image", not a one-frame video.
const IMAGE_FORMATS: [&str; 6] = [
    "image2",
    "png_pipe",
    "jpeg_pipe",
    "webp_pipe",
    "gif",
    "bmp_pipe",
];

/// True for streams an mkv/mp3/m4a container attaches as artwork rather than playing them.
///
/// Cover art is reported by ffprobe as a `video` stream of a still-image codec. Treating it as
/// the asset's video stream would classify every tagged audio file as video and generate
/// thumbnails, filmstrips and even proxies of the album art.
fn is_attached_pic(stream: &Value) -> bool {
    stream
        .get("disposition")
        .and_then(|disposition| disposition.get("attached_pic"))
        .and_then(Value::as_i64)
        .is_some_and(|flag| flag != 0)
}

/// Turns raw `ffprobe -print_format json` output into normalized metadata.
///
/// Kept free of I/O so every container quirk can be covered by a fixture test.
pub fn parse_probe_output(probe: &Value, size_bytes: u64) -> AppResult<MediaMetadata> {
    let streams = probe
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| AppError::UnsupportedMedia("ffprobe returned no streams array".into()))?;

    let video = streams
        .iter()
        .filter(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("video"))
        .filter(|stream| !is_attached_pic(stream))
        .find_map(parse_video_stream);

    let audio = streams
        .iter()
        .find(|stream| stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
        .map(parse_audio_stream);

    if video.is_none() && audio.is_none() {
        return Err(AppError::UnsupportedMedia(
            "file contains no decodable video or audio stream".into(),
        ));
    }

    let format = probe.get("format");
    let format_name = format
        .and_then(|f| f.get("format_name"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let is_image = format_name.as_deref().is_some_and(|name| {
        name.split(',')
            .any(|part| IMAGE_FORMATS.contains(&part.trim()))
    });

    let kind = if is_image {
        MediaKind::Image
    } else if video.is_some() {
        MediaKind::Video
    } else {
        MediaKind::Audio
    };

    // Container duration is authoritative; fall back to the longest stream duration for
    // containers (e.g. raw streams) that do not carry one.
    let duration_sec = as_f64(format.and_then(|f| f.get("duration")))
        .or_else(|| {
            streams
                .iter()
                .filter_map(|stream| as_f64(stream.get("duration")))
                .fold(None, |longest: Option<f64>, value| {
                    Some(longest.map_or(value, |current| current.max(value)))
                })
        })
        .unwrap_or(0.0);

    if kind != MediaKind::Image && duration_sec <= 0.0 {
        return Err(AppError::UnsupportedMedia(
            "file reports a zero duration".into(),
        ));
    }

    let size_bytes = as_u64(format.and_then(|f| f.get("size")))
        .filter(|size| *size > 0)
        .unwrap_or(size_bytes);

    Ok(MediaMetadata {
        kind,
        container: format_name,
        duration_sec,
        size_bytes,
        video,
        audio,
    })
}

/// Result of probing a file: normalized metadata plus the raw ffprobe JSON, which is persisted so
/// later phases can mine fields this parser does not model yet.
#[derive(Debug, Clone)]
pub struct ProbeResult {
    pub metadata: MediaMetadata,
    pub raw_json: String,
}

/// Runs `ffprobe` against a file. Blocking; callers run it on a worker thread.
pub fn probe_file(tools: &FfmpegTools, path: &Path) -> AppResult<ProbeResult> {
    if !path.is_file() {
        return Err(AppError::MediaFileNotFound(path.to_path_buf()));
    }

    let size_bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);

    let output = command(tools.ffprobe())
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
        ])
        .arg(path)
        .output()?;

    if !output.status.success() {
        return Err(AppError::ToolFailed {
            tool: "ffprobe".into(),
            code: output
                .status
                .code()
                .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    let raw_json = String::from_utf8_lossy(&output.stdout).into_owned();
    let probe: Value = serde_json::from_str(&raw_json)?;
    let metadata = parse_probe_output(&probe, size_bytes)?;

    debug!(
        target: category::MEDIA,
        path = %path.display(),
        duration = metadata.duration_sec,
        kind = %metadata.kind,
        "probed media"
    );

    Ok(ProbeResult { metadata, raw_json })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn podcast_probe() -> Value {
        json!({
            "streams": [
                {
                    "index": 0,
                    "codec_name": "h264",
                    "codec_type": "video",
                    "width": 1920,
                    "height": 1080,
                    "pix_fmt": "yuv420p",
                    "r_frame_rate": "30000/1001",
                    "avg_frame_rate": "30000/1001",
                    "bit_rate": "8000000",
                    "duration": "3600.100000"
                },
                {
                    "index": 1,
                    "codec_name": "aac",
                    "codec_type": "audio",
                    "channels": 2,
                    "sample_rate": "48000",
                    "bit_rate": "192000",
                    "duration": "3600.120000"
                }
            ],
            "format": {
                "format_name": "mov,mp4,m4a,3gp,3g2,mj2",
                "duration": "3600.120000",
                "size": "4294967296",
                "bit_rate": "9542000"
            }
        })
    }

    #[test]
    fn parses_a_typical_podcast_recording() {
        let metadata = parse_probe_output(&podcast_probe(), 0).expect("parses");

        assert_eq!(metadata.kind, MediaKind::Video);
        assert_eq!(metadata.duration_sec, 3600.12);
        assert_eq!(metadata.size_bytes, 4_294_967_296);
        assert_eq!(
            metadata.container.as_deref(),
            Some("mov,mp4,m4a,3gp,3g2,mj2")
        );

        let video = metadata.video.expect("video stream");
        assert_eq!(video.codec, "h264");
        assert_eq!((video.width, video.height), (1920, 1080));
        assert!((video.fps - 29.97002997).abs() < 1e-6);
        assert_eq!(video.bit_rate, Some(8_000_000));

        let audio = metadata.audio.expect("audio stream");
        assert_eq!(audio.codec, "aac");
        assert_eq!(audio.sample_rate, 48_000);
    }

    #[test]
    fn landscape_sources_are_flagged_for_reframing() {
        let metadata = parse_probe_output(&podcast_probe(), 0).expect("parses");
        assert!(metadata.video.expect("video").needs_reframe_for_vertical());
    }

    #[test]
    fn display_matrix_rotation_swaps_display_dimensions() {
        let probe = json!({
            "streams": [{
                "codec_name": "hevc",
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "30/1",
                "side_data_list": [{ "rotation": -90 }]
            }],
            "format": { "format_name": "mov,mp4", "duration": "12.0", "size": "100" }
        });

        let video = parse_probe_output(&probe, 0)
            .expect("parses")
            .video
            .expect("video");
        assert_eq!(video.rotation, 270);
        assert_eq!((video.width, video.height), (1920, 1080));
        assert_eq!((video.display_width, video.display_height), (1080, 1920));
        assert!(!video.needs_reframe_for_vertical());
    }

    #[test]
    fn legacy_rotate_tag_is_honored() {
        let probe = json!({
            "streams": [{
                "codec_name": "h264",
                "codec_type": "video",
                "width": 1280,
                "height": 720,
                "avg_frame_rate": "25/1",
                "tags": { "rotate": "90" }
            }],
            "format": { "format_name": "mov,mp4", "duration": "5.0", "size": "10" }
        });

        let video = parse_probe_output(&probe, 0)
            .expect("parses")
            .video
            .expect("video");
        assert_eq!(video.rotation, 90);
        assert_eq!((video.display_width, video.display_height), (720, 1280));
    }

    #[test]
    fn half_turn_rotation_keeps_dimensions() {
        let probe = json!({
            "streams": [{
                "codec_name": "h264",
                "codec_type": "video",
                "width": 1920,
                "height": 1080,
                "avg_frame_rate": "25/1",
                "side_data_list": [{ "rotation": 180 }]
            }],
            "format": { "format_name": "mov,mp4", "duration": "5.0", "size": "10" }
        });

        let video = parse_probe_output(&probe, 0)
            .expect("parses")
            .video
            .expect("video");
        assert_eq!(video.rotation, 180);
        assert_eq!((video.display_width, video.display_height), (1920, 1080));
    }

    #[test]
    fn audio_only_files_are_classified_as_audio() {
        let probe = json!({
            "streams": [{
                "codec_name": "mp3",
                "codec_type": "audio",
                "channels": 1,
                "sample_rate": "44100"
            }],
            "format": { "format_name": "mp3", "duration": "180.5", "size": "2880000" }
        });

        let metadata = parse_probe_output(&probe, 0).expect("parses");
        assert_eq!(metadata.kind, MediaKind::Audio);
        assert!(metadata.video.is_none());
        assert_eq!(metadata.duration_sec, 180.5);
    }

    #[test]
    fn still_images_are_classified_as_images_despite_having_a_video_stream() {
        let probe = json!({
            "streams": [{
                "codec_name": "png",
                "codec_type": "video",
                "width": 1080,
                "height": 1080,
                "avg_frame_rate": "0/0"
            }],
            "format": { "format_name": "png_pipe", "duration": "0", "size": "51200" }
        });

        let metadata = parse_probe_output(&probe, 0).expect("parses");
        assert_eq!(metadata.kind, MediaKind::Image);
        // A zero duration is legitimate for a still, so it must not be rejected.
        assert_eq!(metadata.duration_sec, 0.0);
    }

    #[test]
    fn unparseable_frame_rate_falls_back_to_zero_rather_than_failing() {
        let probe = json!({
            "streams": [{
                "codec_name": "h264",
                "codec_type": "video",
                "width": 640,
                "height": 480,
                "avg_frame_rate": "0/0",
                "r_frame_rate": "0/0"
            }],
            "format": { "format_name": "matroska,webm", "duration": "10.0", "size": "1000" }
        });

        let video = parse_probe_output(&probe, 0)
            .expect("parses")
            .video
            .expect("video");
        assert_eq!(video.fps, 0.0);
    }

    #[test]
    fn avg_frame_rate_is_preferred_over_r_frame_rate() {
        let probe = json!({
            "streams": [{
                "codec_name": "h264",
                "codec_type": "video",
                "width": 640,
                "height": 480,
                "avg_frame_rate": "24/1",
                "r_frame_rate": "60/1"
            }],
            "format": { "format_name": "matroska,webm", "duration": "10.0", "size": "1000" }
        });

        assert_eq!(
            parse_probe_output(&probe, 0)
                .expect("parses")
                .video
                .expect("video")
                .fps,
            24.0
        );
    }

    #[test]
    fn duration_falls_back_to_the_longest_stream() {
        let probe = json!({
            "streams": [
                { "codec_name": "h264", "codec_type": "video", "width": 640, "height": 480,
                  "avg_frame_rate": "25/1", "duration": "10.0" },
                { "codec_name": "aac", "codec_type": "audio", "channels": 2,
                  "sample_rate": "48000", "duration": "12.5" }
            ],
            "format": { "format_name": "mpegts", "size": "1000" }
        });

        assert_eq!(
            parse_probe_output(&probe, 0).expect("parses").duration_sec,
            12.5
        );
    }

    #[test]
    fn filesystem_size_is_used_when_the_container_omits_it() {
        let probe = json!({
            "streams": [{ "codec_name": "aac", "codec_type": "audio", "channels": 2,
                          "sample_rate": "48000", "duration": "5.0" }],
            "format": { "format_name": "aac", "duration": "5.0" }
        });

        assert_eq!(
            parse_probe_output(&probe, 7_777)
                .expect("parses")
                .size_bytes,
            7_777
        );
    }

    #[test]
    fn a_file_with_no_usable_stream_is_rejected() {
        let probe = json!({ "streams": [], "format": { "format_name": "data" } });
        let error = parse_probe_output(&probe, 0).expect_err("no streams");
        assert_eq!(error.kind(), "unsupported_media");
    }

    #[test]
    fn a_zero_duration_video_is_rejected() {
        let probe = json!({
            "streams": [{ "codec_name": "h264", "codec_type": "video", "width": 640,
                          "height": 480, "avg_frame_rate": "25/1" }],
            "format": { "format_name": "mov,mp4", "duration": "0", "size": "100" }
        });
        let error = parse_probe_output(&probe, 0).expect_err("zero duration");
        assert_eq!(error.kind(), "unsupported_media");
    }

    #[test]
    fn missing_streams_array_is_rejected() {
        let error = parse_probe_output(&json!({}), 0).expect_err("malformed");
        assert_eq!(error.kind(), "unsupported_media");
    }

    #[test]
    fn rationals_parse_and_reject_degenerate_values() {
        assert_eq!(parse_rational("30/1"), Some(30.0));
        assert_eq!(
            parse_rational("30000/1001").map(|v| (v * 1e4).round()),
            Some(299_700.0)
        );
        assert_eq!(parse_rational("0/0"), None);
        assert_eq!(parse_rational("25/0"), None);
        assert_eq!(parse_rational("not-a-rational"), None);
    }

    #[test]
    fn attached_cover_art_does_not_win_over_the_real_video_stream() {
        // Podcast MP4s often carry a cover-art mjpeg stream first.
        let probe = json!({
            "streams": [
                { "codec_name": "mjpeg", "codec_type": "video", "width": 600, "height": 600,
                  "avg_frame_rate": "0/0", "disposition": { "attached_pic": 1 } },
                { "codec_name": "h264", "codec_type": "video", "width": 1920, "height": 1080,
                  "avg_frame_rate": "30/1", "disposition": { "attached_pic": 0 } },
                { "codec_name": "aac", "codec_type": "audio", "channels": 2, "sample_rate": "48000" }
            ],
            "format": { "format_name": "mov,mp4", "duration": "60.0", "size": "1000" }
        });

        let metadata = parse_probe_output(&probe, 0).expect("parses");
        assert_eq!(metadata.kind, MediaKind::Video);
        let video = metadata.video.expect("video");
        assert_eq!(video.codec, "h264");
        assert_eq!(video.display_width, 1920);
    }

    #[test]
    fn a_tagged_audio_file_is_audio_not_cover_art_video() {
        // Every mp3 with embedded art reports the artwork as a video stream.
        let probe = json!({
            "streams": [
                { "codec_name": "mjpeg", "codec_type": "video", "width": 600, "height": 600,
                  "avg_frame_rate": "0/0", "disposition": { "attached_pic": 1 } },
                { "codec_name": "mp3", "codec_type": "audio", "channels": 2, "sample_rate": "44100" }
            ],
            "format": { "format_name": "mp3", "duration": "1800.0", "size": "1000" }
        });

        let metadata = parse_probe_output(&probe, 0).expect("parses");
        assert_eq!(metadata.kind, MediaKind::Audio);
        assert!(metadata.video.is_none());
    }

    #[test]
    fn an_audio_file_with_only_cover_art_is_still_audio() {
        // Defensive: some containers report no audio disposition at all.
        let probe = json!({
            "streams": [
                { "codec_name": "mjpeg", "codec_type": "video", "width": 600, "height": 600,
                  "disposition": { "attached_pic": 1 } }
            ],
            "format": { "format_name": "mp3", "duration": "1.0", "size": "1000" }
        });

        assert!(parse_probe_output(&probe, 0).is_err());
    }
}
