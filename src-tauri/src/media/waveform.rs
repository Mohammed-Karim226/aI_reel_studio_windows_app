use std::ffi::OsString;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::media::ffmpeg::FfmpegTools;
use crate::media::runner::{args, push_path, run_with_stdout_sink, CancelToken};

/// Decode rate for waveform extraction. Peak envelopes only need enough resolution to draw a
/// few thousand columns, so 8 kHz mono keeps an hour of audio under 60 MB of streamed PCM.
pub const WAVEFORM_SAMPLE_RATE: u32 = 8_000;
/// Column count in the stored envelope. 2000 covers a 4K-wide timeline without interpolation.
pub const DEFAULT_WAVEFORM_BUCKETS: usize = 2_000;
/// Schema version of the stored JSON, so a future change can migrate instead of crashing.
pub const WAVEFORM_SCHEMA_VERSION: u32 = 1;

/// The peak envelope written next to the project, ready for the timeline to draw.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WaveformData {
    pub version: u32,
    pub sample_rate: u32,
    pub duration_sec: f64,
    /// One peak per column, `0..=255`. `u8` rather than `f32` keeps the JSON file small enough
    /// to load synchronously when a project is reopened.
    pub peaks: Vec<u8>,
}

/// Folds a stream of signed 16-bit little-endian mono samples into a fixed number of peak buckets.
///
/// Built for streaming: ffmpeg's PCM arrives in arbitrary chunks that can split a sample across a
/// read boundary, so a half-sample is carried over rather than dropped.
#[derive(Debug)]
pub struct PeakBuilder {
    target_buckets: usize,
    samples_per_bucket: u64,
    samples_in_bucket: u64,
    peak_in_bucket: i32,
    peaks: Vec<u8>,
    pending_byte: Option<u8>,
    samples_seen: u64,
}

impl PeakBuilder {
    /// `expected_samples` comes from the probed duration and only sets the bucket width; an
    /// inaccurate value degrades resolution but never loses or misplaces audio.
    pub fn new(expected_samples: u64, target_buckets: usize) -> Self {
        let target_buckets = target_buckets.max(1);
        let samples_per_bucket = (expected_samples / target_buckets as u64).max(1);

        Self {
            target_buckets,
            samples_per_bucket,
            samples_in_bucket: 0,
            peak_in_bucket: 0,
            peaks: Vec::with_capacity(target_buckets),
            pending_byte: None,
            samples_seen: 0,
        }
    }

    pub fn samples_seen(&self) -> u64 {
        self.samples_seen
    }

    pub fn push_bytes(&mut self, bytes: &[u8]) {
        let mut rest = bytes;

        if let Some(low) = self.pending_byte.take() {
            match rest.split_first() {
                Some((high, tail)) => {
                    self.push_sample(i16::from_le_bytes([low, *high]));
                    rest = tail;
                }
                None => {
                    self.pending_byte = Some(low);
                    return;
                }
            }
        }

        let (samples, remainder) = rest.as_chunks::<2>();
        for sample in samples {
            self.push_sample(i16::from_le_bytes(*sample));
        }
        if let [orphan] = remainder {
            self.pending_byte = Some(*orphan);
        }
    }

    fn push_sample(&mut self, sample: i16) {
        // `abs()` on i16::MIN would overflow, so widen first.
        let magnitude = i32::from(sample).abs();
        if magnitude > self.peak_in_bucket {
            self.peak_in_bucket = magnitude;
        }
        self.samples_in_bucket += 1;
        self.samples_seen += 1;

        if self.samples_in_bucket >= self.samples_per_bucket {
            self.flush_bucket();
        }
    }

    fn flush_bucket(&mut self) {
        let scaled = scale_peak(self.peak_in_bucket);
        if self.peaks.len() < self.target_buckets {
            self.peaks.push(scaled);
        } else if let Some(last) = self.peaks.last_mut() {
            // The duration was underestimated. Fold the overflow into the final column rather
            // than growing past the promised length or discarding real audio.
            *last = (*last).max(scaled);
        }
        self.samples_in_bucket = 0;
        self.peak_in_bucket = 0;
    }

    /// Flushes the partial bucket and pads to the promised length.
    pub fn finish(mut self) -> Vec<u8> {
        if self.samples_in_bucket > 0 {
            self.flush_bucket();
        }
        self.peaks.resize(self.target_buckets, 0);
        self.peaks
    }
}

fn scale_peak(magnitude: i32) -> u8 {
    let scaled = magnitude.saturating_mul(255) / i32::from(i16::MAX);
    scaled.clamp(0, 255) as u8
}

/// `ffmpeg` arguments that decode the first audio stream to raw mono PCM on stdout.
pub fn waveform_args(source: &Path) -> Vec<OsString> {
    let mut arguments = args(["-hide_banner", "-v", "error", "-nostdin", "-i"]);
    push_path(&mut arguments, source);
    arguments.extend(args(["-vn", "-map", "0:a:0", "-ac", "1", "-ar"]));
    arguments.push(OsString::from(WAVEFORM_SAMPLE_RATE.to_string()));
    arguments.extend(args(["-f", "s16le", "-"]));
    arguments
}

/// Decodes the audio track and writes the peak envelope as JSON.
pub fn generate_waveform(
    tools: &FfmpegTools,
    source: &Path,
    output: &Path,
    duration_sec: f64,
    buckets: usize,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(f64),
) -> AppResult<WaveformData> {
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let expected_samples = if duration_sec.is_finite() && duration_sec > 0.0 {
        (duration_sec * f64::from(WAVEFORM_SAMPLE_RATE)) as u64
    } else {
        0
    };
    let expected_bytes = (expected_samples * 2) as f64;

    let mut builder = PeakBuilder::new(expected_samples, buckets);
    let mut consumed_bytes = 0_u64;

    run_with_stdout_sink(
        tools.ffmpeg(),
        &waveform_args(source),
        cancel,
        &mut |chunk| {
            builder.push_bytes(chunk);
            consumed_bytes += chunk.len() as u64;
            if expected_bytes > 0.0 {
                on_progress((consumed_bytes as f64 / expected_bytes).clamp(0.0, 1.0));
            }
            true
        },
    )?;

    let data = WaveformData {
        version: WAVEFORM_SCHEMA_VERSION,
        sample_rate: WAVEFORM_SAMPLE_RATE,
        duration_sec,
        peaks: builder.finish(),
    };

    std::fs::write(output, serde_json::to_vec(&data)?)?;
    on_progress(1.0);
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(samples: &[i16]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_le_bytes()).collect()
    }

    #[test]
    fn silence_produces_a_flat_envelope() {
        let mut builder = PeakBuilder::new(400, 4);
        builder.push_bytes(&pcm(&[0; 400]));
        assert_eq!(builder.finish(), vec![0, 0, 0, 0]);
    }

    #[test]
    fn full_scale_audio_reaches_the_top_of_the_envelope() {
        let mut builder = PeakBuilder::new(400, 4);
        builder.push_bytes(&pcm(&[i16::MAX; 400]));
        assert_eq!(builder.finish(), vec![255, 255, 255, 255]);
    }

    #[test]
    fn half_scale_audio_lands_near_the_middle() {
        let mut builder = PeakBuilder::new(100, 1);
        builder.push_bytes(&pcm(&[i16::MAX / 2; 100]));
        let peaks = builder.finish();
        assert!(
            (126..=128).contains(&peaks[0]),
            "expected a mid-scale peak, got {}",
            peaks[0]
        );
    }

    #[test]
    fn the_most_negative_sample_does_not_overflow() {
        // i16::MIN.abs() panics in debug builds if the magnitude is not widened first.
        let mut builder = PeakBuilder::new(2, 1);
        builder.push_bytes(&pcm(&[i16::MIN, i16::MIN]));
        assert_eq!(builder.finish(), vec![255]);
    }

    #[test]
    fn each_bucket_keeps_its_own_peak() {
        let mut builder = PeakBuilder::new(4, 2);
        builder.push_bytes(&pcm(&[0, 0, i16::MAX, i16::MAX]));
        assert_eq!(builder.finish(), vec![0, 255]);
    }

    #[test]
    fn a_transient_inside_a_bucket_is_preserved() {
        let mut samples = vec![0_i16; 100];
        samples[50] = i16::MAX;
        let mut builder = PeakBuilder::new(100, 1);
        builder.push_bytes(&pcm(&samples));
        assert_eq!(
            builder.finish(),
            vec![255],
            "peaks must not be averaged away"
        );
    }

    #[test]
    fn a_sample_split_across_two_reads_is_reassembled() {
        let bytes = pcm(&[i16::MAX, i16::MAX]);
        let mut builder = PeakBuilder::new(2, 1);
        // Split mid-sample, the way a 64 KiB pipe read can.
        builder.push_bytes(&bytes[..1]);
        builder.push_bytes(&bytes[1..]);
        assert_eq!(builder.samples_seen(), 2);
        assert_eq!(builder.finish(), vec![255]);
    }

    #[test]
    fn a_trailing_orphan_byte_is_dropped_rather_than_misread() {
        let mut bytes = pcm(&[i16::MAX]);
        bytes.push(0x7f);
        let mut builder = PeakBuilder::new(1, 1);
        builder.push_bytes(&bytes);
        assert_eq!(builder.samples_seen(), 1);
    }

    #[test]
    fn an_empty_chunk_does_not_disturb_a_pending_byte() {
        let bytes = pcm(&[i16::MAX]);
        let mut builder = PeakBuilder::new(1, 1);
        builder.push_bytes(&bytes[..1]);
        builder.push_bytes(&[]);
        builder.push_bytes(&bytes[1..]);
        assert_eq!(builder.samples_seen(), 1);
        assert_eq!(builder.finish(), vec![255]);
    }

    #[test]
    fn the_envelope_is_always_the_promised_length() {
        // Far fewer samples than expected: the tail is padded, not truncated.
        let mut builder = PeakBuilder::new(1_000, 10);
        builder.push_bytes(&pcm(&[i16::MAX; 100]));
        let peaks = builder.finish();
        assert_eq!(peaks.len(), 10);
        assert_eq!(peaks[0], 255);
        assert_eq!(peaks[9], 0);
    }

    #[test]
    fn extra_audio_folds_into_the_last_column_instead_of_growing() {
        // Duration underestimated by 4x; length must still hold.
        let mut builder = PeakBuilder::new(100, 10);
        builder.push_bytes(&pcm(&[i16::MAX; 400]));
        let peaks = builder.finish();
        assert_eq!(peaks.len(), 10);
        assert!(peaks.iter().all(|peak| *peak == 255));
    }

    #[test]
    fn no_audio_at_all_yields_an_empty_but_valid_envelope() {
        let builder = PeakBuilder::new(1_000, 16);
        let peaks = builder.finish();
        assert_eq!(peaks.len(), 16);
        assert!(peaks.iter().all(|peak| *peak == 0));
    }

    #[test]
    fn a_zero_bucket_request_is_corrected_rather_than_dividing_by_zero() {
        let mut builder = PeakBuilder::new(100, 0);
        builder.push_bytes(&pcm(&[i16::MAX; 100]));
        assert_eq!(builder.finish().len(), 1);
    }

    #[test]
    fn arguments_request_mono_pcm_on_stdout() {
        let arguments = waveform_args(Path::new(r"D:\a.mp4"))
            .iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(arguments.contains("-ac 1"));
        assert!(arguments.contains("-ar 8000"));
        assert!(arguments.contains("-f s16le"));
        assert!(arguments.contains("-vn"));
        assert!(arguments.ends_with(" -"));
    }

    #[test]
    fn waveform_json_round_trips() {
        let data = WaveformData {
            version: WAVEFORM_SCHEMA_VERSION,
            sample_rate: WAVEFORM_SAMPLE_RATE,
            duration_sec: 12.5,
            peaks: vec![0, 128, 255],
        };
        let encoded = serde_json::to_string(&data).expect("encode");
        assert!(encoded.contains("\"sampleRate\":8000"));
        assert_eq!(
            serde_json::from_str::<WaveformData>(&encoded).expect("decode"),
            data
        );
    }
}
