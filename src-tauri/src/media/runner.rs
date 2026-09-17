use std::ffi::{OsStr, OsString};
use std::io::{BufRead, BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

use tracing::debug;

use crate::error::{AppError, AppResult};
use crate::logging::category;
use crate::media::progress::ProgressParser;

/// Keep only the tail of stderr: ffmpeg's banner is noise, the error is always at the end.
const STDERR_TAIL_LIMIT: usize = 8 * 1024;

/// Windows `CREATE_NO_WINDOW`. Without it every ffmpeg invocation flashes a console window over
/// the app, which looks broken to the user.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A cooperative cancellation flag shared between a command handler and a worker thread.
///
/// Cloning shares the same flag, so the UI can cancel a job that a worker is still running.
#[derive(Debug, Clone, Default)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }
}

/// Builds a `Command` that will not pop up a console window on Windows.
pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// Convenience for building argument lists without fighting `OsString` at every call site.
pub fn args<const N: usize>(values: [&str; N]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}

fn spawn_stderr_drain(child: &mut Child) -> Option<JoinHandle<String>> {
    let stderr = child.stderr.take()?;
    Some(std::thread::spawn(move || {
        let mut buffer = String::new();
        let mut reader = BufReader::new(stderr);
        let mut chunk = [0_u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    buffer.push_str(&String::from_utf8_lossy(&chunk[..read]));
                    if buffer.len() > STDERR_TAIL_LIMIT * 2 {
                        // Drop the head; only the tail is diagnostically useful.
                        let keep = buffer.len() - STDERR_TAIL_LIMIT;
                        buffer = buffer.split_off(keep);
                    }
                }
            }
        }
        buffer
    }))
}

fn collect_stderr(handle: Option<JoinHandle<String>>) -> String {
    handle
        .and_then(|handle| handle.join().ok())
        .unwrap_or_default()
        .trim()
        .to_string()
}

/// Waits for the child, turning a non-zero exit into a typed error carrying the stderr tail.
fn finish(
    mut child: Child,
    stderr: Option<JoinHandle<String>>,
    tool: &str,
    cancelled: bool,
) -> AppResult<String> {
    if cancelled {
        // The child is still running; stop it before reaping so we do not block forever.
        let _ = child.kill();
        let _ = child.wait();
        drop(collect_stderr(stderr));
        return Err(AppError::JobCancelled);
    }

    let status = child.wait()?;
    let stderr = collect_stderr(stderr);

    if !status.success() {
        return Err(AppError::ToolFailed {
            tool: tool.to_string(),
            code: status
                .code()
                .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            stderr,
        });
    }

    Ok(stderr)
}

/// Runs ffmpeg, reporting progress as a `0.0..=1.0` fraction.
///
/// `-progress pipe:1` is appended here, so callers must not pass it themselves. Cancellation is
/// observed between progress blocks (ffmpeg emits one roughly every half second), which bounds
/// cancel latency without a second watchdog thread.
pub fn run_with_progress(
    ffmpeg: &Path,
    arguments: &[OsString],
    duration_sec: f64,
    cancel: &CancelToken,
    on_progress: &mut dyn FnMut(f64),
) -> AppResult<String> {
    let mut child = command(ffmpeg)
        .args(arguments)
        .args(["-progress", "pipe:1", "-nostats"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    debug!(
        target: category::MEDIA,
        argc = arguments.len(),
        duration = duration_sec,
        "ffmpeg started"
    );

    let stderr = spawn_stderr_drain(&mut child);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("ffmpeg stdout was not captured".into()))?;

    let mut parser = ProgressParser::new();
    let mut cancelled = false;

    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        if let Some(update) = parser.push_line(&line) {
            if let Some(fraction) = update.fraction(duration_sec) {
                on_progress(fraction);
            }
        }
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
    }

    finish(child, stderr, "ffmpeg", cancelled)
}

/// Runs ffmpeg with raw binary output on stdout, handing each chunk to `sink`.
///
/// Used for waveform extraction, where buffering an hour of PCM in memory would cost tens of
/// megabytes for no reason. `sink` returning `false` stops the run early.
pub fn run_with_stdout_sink(
    ffmpeg: &Path,
    arguments: &[OsString],
    cancel: &CancelToken,
    sink: &mut dyn FnMut(&[u8]) -> bool,
) -> AppResult<String> {
    let mut child = command(ffmpeg)
        .args(arguments)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    let stderr = spawn_stderr_drain(&mut child);
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::Internal("ffmpeg stdout was not captured".into()))?;

    let mut buffer = vec![0_u8; 64 * 1024];
    let mut cancelled = false;

    loop {
        match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                if !sink(&buffer[..read]) {
                    break;
                }
            }
            Err(_) => break,
        }
        if cancel.is_cancelled() {
            cancelled = true;
            break;
        }
    }

    finish(child, stderr, "ffmpeg", cancelled)
}

/// Runs a tool to completion and returns its stdout. For short, non-streaming invocations such
/// as single-frame extraction or `-version` queries.
pub fn run_to_completion(program: &Path, arguments: &[OsString], tool: &str) -> AppResult<Vec<u8>> {
    let output = command(program).args(arguments).output()?;

    if !output.status.success() {
        return Err(AppError::ToolFailed {
            tool: tool.to_string(),
            code: output
                .status
                .code()
                .map_or_else(|| "signal".to_string(), |code| code.to_string()),
            stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
        });
    }

    Ok(output.stdout)
}

/// Appends a path argument, keeping non-UTF-8 paths intact.
pub fn push_path(arguments: &mut Vec<OsString>, path: &Path) {
    arguments.push(OsStr::new(path).to_os_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fresh_token_is_not_cancelled() {
        assert!(!CancelToken::new().is_cancelled());
    }

    #[test]
    fn cancellation_is_visible_through_every_clone() {
        let token = CancelToken::new();
        let clone = token.clone();
        token.cancel();
        assert!(clone.is_cancelled(), "clones must share the same flag");
    }

    #[test]
    fn cancelling_twice_is_harmless() {
        let token = CancelToken::new();
        token.cancel();
        token.cancel();
        assert!(token.is_cancelled());
    }

    #[test]
    fn args_builds_an_os_string_vector() {
        let built = args(["-y", "-i", "input.mp4"]);
        assert_eq!(built.len(), 3);
        assert_eq!(built[1], OsString::from("-i"));
    }

    #[test]
    fn push_path_preserves_windows_separators() {
        let mut arguments = args(["-i"]);
        push_path(&mut arguments, Path::new(r"D:\media\my video.mp4"));
        assert_eq!(arguments[1], OsString::from(r"D:\media\my video.mp4"));
    }

    #[test]
    fn running_a_missing_executable_surfaces_an_io_error() {
        let error = run_to_completion(
            Path::new("definitely-not-a-real-executable-xyz"),
            &args(["-version"]),
            "ffmpeg",
        )
        .expect_err("missing executable");
        assert_eq!(error.kind(), "io");
    }
}
