//! Provider-independent transcription input plus a local faster-whisper implementation.
mod process;
pub mod queue;
pub mod setup;

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::captions::{validate_words, CaptionWord};
use crate::error::{AppError, AppResult};
use crate::media::ffmpeg::FfmpegTools;
use crate::media::progress::ProgressParser;
use crate::media::runner::{self, CancelToken};
use crate::media::types::MediaAsset;
use crate::timeline::invalid;

const HELPER: &str = include_str!("faster_whisper.py");
const TRANSCRIPT_LIMIT: usize = 16 * 1024 * 1024;
pub const MAX_DURATION: f64 = 3600.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Transcript {
    pub language: String,
    pub words: Vec<CaptionWord>,
}

pub struct TranscriptionInput<'a> {
    pub audio_path: &'a Path,
    pub language: &'a str,
    pub duration: f64,
}

pub trait TranscriptionProvider {
    fn transcribe(
        &self,
        input: &TranscriptionInput<'_>,
        cancel: &CancelToken,
        progress: &mut dyn FnMut(f64),
    ) -> AppResult<Transcript>;
}

pub struct FasterWhisper {
    python: PathBuf,
    model: PathBuf,
}

impl FasterWhisper {
    pub fn new(python: &str, model: &str) -> AppResult<Self> {
        let python = setup::normalize_path(python, "Python executable")?;
        let python = if python.trim().is_empty() {
            "python"
        } else {
            &python
        };
        Ok(Self {
            python: PathBuf::from(python),
            model: local_model_path(model)?,
        })
    }

    fn arguments(&self, input: &TranscriptionInput<'_>) -> Vec<OsString> {
        let mut arguments = runner::args(["-I", "-u", "-c", HELPER]);
        runner::push_path(&mut arguments, &self.model);
        runner::push_path(&mut arguments, input.audio_path);
        arguments.push(input.language.into());
        arguments.push(input.duration.to_string().into());
        arguments
    }
}

fn local_model_path(model: &str) -> AppResult<PathBuf> {
    let model = setup::normalize_path(model, "model folder")?;
    let model = Path::new(&model);
    if !model.is_absolute()
        || !model.is_dir()
        || !model.join("model.bin").is_file()
        || !model.join("config.json").is_file()
        || !model.join("tokenizer.json").is_file()
    {
        return Err(AppError::TranscriptionUnavailable("Choose an existing local faster-whisper (CTranslate2) model folder containing model.bin, config.json, and tokenizer.json. Models are never downloaded automatically.".into()));
    }
    Ok(model.canonicalize()?)
}

impl TranscriptionProvider for FasterWhisper {
    fn transcribe(
        &self,
        input: &TranscriptionInput<'_>,
        cancel: &CancelToken,
        progress: &mut dyn FnMut(f64),
    ) -> AppResult<Transcript> {
        validate_range(0.0, input.duration, input.duration, input.language)?;
        let mut command = runner::command(&self.python);
        command.args(self.arguments(input));
        let mut lines = Lines::default();
        let output = process::run(&mut command, "Local transcription", cancel, Duration::from_secs(3600), TRANSCRIPT_LIMIT, &mut |chunk| {
            lines.push(chunk, &mut |line| {
                if let Ok(record) = serde_json::from_slice::<ProgressRecord>(line) {
                    if record.progress.is_finite() {
                        progress(record.progress.clamp(0.0, 1.0));
                    }
                }
            });
        }).map_err(|error| match error {
            AppError::Io(error) if error.kind() == std::io::ErrorKind::NotFound => AppError::TranscriptionUnavailable("Python was not found. Set the Python executable path for an environment with faster-whisper installed.".into()),
            other => other,
        })?;
        if !output.status.success() {
            if let Some(error) = parse_provider_error(&output.stdout) {
                return Err(error);
            }
            return Err(AppError::TranscriptionFailed(format!("Python transcription exited with {}. Verify faster-whisper and the local model. {}", output.status, output.stderr)));
        }
        parse_transcript(&output.stdout, input.duration)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ProgressRecord {
    progress: f64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FailureRecord {
    error: String,
    kind: String,
}

fn parse_provider_error(output: &[u8]) -> Option<AppError> {
    output.split(|byte| *byte == b'\n').find_map(|line| {
        let error = serde_json::from_slice::<FailureRecord>(line).ok()?;
        Some(if error.kind == "unavailable" {
            AppError::TranscriptionUnavailable(error.error)
        } else {
            AppError::TranscriptionFailed(error.error)
        })
    })
}

fn parse_transcript(output: &[u8], duration: f64) -> AppResult<Transcript> {
    let failed = |message: &str| AppError::TranscriptionFailed(message.into());
    if output.len() > TRANSCRIPT_LIMIT {
        return Err(failed("Transcript is too large. Try a shorter clip."));
    }
    if let Some(error) = parse_provider_error(output) {
        return Err(error);
    }
    let mut transcript = None;
    for line in output
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        if serde_json::from_slice::<ProgressRecord>(line).is_ok() {
            continue;
        }
        let parsed: Transcript = serde_json::from_slice(line).map_err(|_| failed("Local provider returned an invalid transcript. Check the selected Python environment."))?;
        if transcript.replace(parsed).is_some() {
            return Err(failed("Local provider returned multiple transcripts."));
        }
    }
    let transcript = transcript.ok_or_else(|| failed("Local provider returned no transcript."))?;
    if transcript.language.is_empty()
        || transcript.language.len() > 32
        || !transcript
            .language
            .bytes()
            .all(|byte| byte.is_ascii_alphabetic() || byte == b'-')
        || transcript.words.len() > 100_000
    {
        return Err(failed(
            "Local provider returned invalid language or too many words.",
        ));
    }
    validate_words(&transcript.words, 0.0, duration)
        .map_err(|error| failed(&format!("Invalid provider timestamps: {error}")))?;
    Ok(transcript)
}

#[derive(Default)]
struct Lines {
    pending: Vec<u8>,
}

impl Lines {
    fn push(&mut self, chunk: &[u8], on_line: &mut dyn FnMut(&[u8])) {
        for portion in chunk.split_inclusive(|byte| *byte == b'\n') {
            self.pending.extend_from_slice(portion);
            if portion.last() == Some(&b'\n') {
                on_line(&self.pending);
                self.pending.clear();
            }
        }
    }
}

pub fn validate_range(start: f64, end: f64, media_duration: f64, language: &str) -> AppResult<()> {
    if ![start, end, media_duration].iter().all(|n| n.is_finite())
        || start < 0.0
        || end <= start
        || end > media_duration + 0.00001
    {
        return Err(invalid(
            "transcription range must lie within the selected media",
        ));
    }
    if end - start > MAX_DURATION {
        return Err(invalid("transcribe a range of one hour or less"));
    }
    if !["auto", "en", "ar"].contains(&language) {
        return Err(invalid("transcription language must be auto, en, or ar"));
    }
    Ok(())
}

/// Owns only one uniquely named request file. Cleanup never traverses a directory.
struct AudioFile(PathBuf);
impl AudioFile {
    fn create(root: &Path) -> AppResult<Self> {
        let root = root.canonicalize()?;
        let mut folder = root.clone();
        for component in ["captions", "transcription"] {
            folder.push(component);
            match std::fs::create_dir(&folder) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            folder = folder.canonicalize()?;
            if !folder.starts_with(&root) {
                return Err(invalid(
                    "transcription folder must remain inside the project",
                ));
            }
        }
        let path = folder.join(format!("{}.wav", uuid::Uuid::new_v4()));
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)?;
        Ok(Self(path))
    }
}
impl Drop for AudioFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn extraction_arguments(source: &Path, target: &Path, start: f64, duration: f64) -> Vec<OsString> {
    let mut args = runner::args([
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-ss",
    ]);
    args.push(start.to_string().into());
    args.push("-i".into());
    runner::push_path(&mut args, source);
    args.push("-t".into());
    args.push(duration.to_string().into());
    args.extend(runner::args([
        "-map",
        "0:a:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-progress",
        "pipe:1",
        "-nostats",
    ]));
    runner::push_path(&mut args, target);
    args
}

pub struct MediaTranscription<'a> {
    pub root: &'a Path,
    pub asset: &'a MediaAsset,
    pub source_start: f64,
    pub source_end: f64,
    pub language: &'a str,
}

pub fn transcribe_media(
    request: &MediaTranscription<'_>,
    tools: &FfmpegTools,
    provider: &dyn TranscriptionProvider,
    cancel: &CancelToken,
    progress: &mut dyn FnMut(f64),
) -> AppResult<Transcript> {
    validate_range(
        request.source_start,
        request.source_end,
        request.asset.duration_sec,
        request.language,
    )?;
    if !request.asset.has_audio {
        return Err(invalid("selected media has no audio stream"));
    }
    let source = Path::new(&request.asset.original_path);
    if !source.is_file() {
        return Err(AppError::MediaFileNotFound(source.into()));
    }
    if cancel.is_cancelled() {
        return Err(AppError::JobCancelled);
    }
    let audio = AudioFile::create(request.root)?;
    let duration = request.source_end - request.source_start;
    let mut command = runner::command(Path::new(&tools.ffmpeg_path));
    command.args(extraction_arguments(
        source,
        &audio.0,
        request.source_start,
        duration,
    ));
    let mut lines = Lines::default();
    let mut parser = ProgressParser::new();
    let output = process::run(
        &mut command,
        "Audio extraction",
        cancel,
        Duration::from_secs(600),
        1024 * 1024,
        &mut |chunk| {
            lines.push(chunk, &mut |line| {
                if let Some(fraction) = parser
                    .push_line(&String::from_utf8_lossy(line))
                    .and_then(|update| update.fraction(duration))
                {
                    progress(fraction * 0.1);
                }
            });
        },
    )?;
    if !output.status.success() {
        return Err(AppError::ToolFailed {
            tool: "ffmpeg audio extraction".into(),
            code: output.status.to_string(),
            stderr: output.stderr,
        });
    }
    progress(0.1);
    let result = provider.transcribe(
        &TranscriptionInput {
            audio_path: &audio.0,
            language: request.language,
            duration,
        },
        cancel,
        &mut |fraction| progress(0.1 + fraction * 0.9),
    )?;
    if cancel.is_cancelled() {
        return Err(AppError::JobCancelled);
    }
    Ok(result)
}

#[cfg(test)]
mod tests;
