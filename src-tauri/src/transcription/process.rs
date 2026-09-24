//! Bounded process capture with cancellation even while a model is loading silently.
use std::io::Read;
use std::process::{Command, ExitStatus, Stdio};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use crate::error::{AppError, AppResult};
use crate::media::runner::CancelToken;

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    exceeded: bool,
    read_error: Option<String>,
}

fn drain(
    reader: impl Read + Send + 'static,
    limit: usize,
) -> (Arc<Mutex<Capture>>, JoinHandle<()>) {
    let captured = Arc::new(Mutex::new(Capture::default()));
    let output = Arc::clone(&captured);
    let thread = thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let mut output = output.lock().unwrap_or_else(|e| e.into_inner());
                    let remaining = limit.saturating_sub(output.bytes.len());
                    output
                        .bytes
                        .extend_from_slice(&buffer[..count.min(remaining)]);
                    output.exceeded |= count > remaining;
                }
                Err(error) => {
                    output.lock().unwrap_or_else(|e| e.into_inner()).read_error =
                        Some(error.to_string());
                    break;
                }
            }
        }
    });
    (captured, thread)
}

pub struct ProcessOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: String,
}

pub fn run(
    command: &mut Command,
    tool: &str,
    cancel: &CancelToken,
    timeout: Duration,
    stdout_limit: usize,
    on_stdout: &mut dyn FnMut(&[u8]),
) -> AppResult<ProcessOutput> {
    if cancel.is_cancelled() {
        return Err(AppError::JobCancelled);
    }
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let (stdout, out_thread) = drain(child.stdout.take().expect("piped stdout"), stdout_limit);
    let (stderr, err_thread) = drain(child.stderr.take().expect("piped stderr"), 64 * 1024);
    let started = Instant::now();
    let mut consumed = 0;
    let outcome = loop {
        let out = stdout.lock().unwrap_or_else(|e| e.into_inner());
        on_stdout(&out.bytes[consumed..]);
        consumed = out.bytes.len();
        let exceeded = out.exceeded || stderr.lock().unwrap_or_else(|e| e.into_inner()).exceeded;
        drop(out);
        if cancel.is_cancelled() {
            break Err(AppError::JobCancelled);
        }
        if exceeded {
            break Err(AppError::TranscriptionFailed(format!(
                "{tool} exceeded its output limit. Try a shorter clip."
            )));
        }
        if started.elapsed() >= timeout {
            break Err(AppError::TranscriptionFailed(format!(
                "{tool} timed out. Try a smaller model or shorter clip."
            )));
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => break Err(AppError::Io(error)),
        }
    };
    if outcome.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = out_thread.join();
    let _ = err_thread.join();
    let status = outcome?;
    let mut stdout = stdout.lock().unwrap_or_else(|e| e.into_inner());
    let stderr = stderr.lock().unwrap_or_else(|e| e.into_inner());
    if stdout.exceeded || stderr.exceeded {
        return Err(AppError::TranscriptionFailed(format!(
            "{tool} exceeded its output limit. Try a shorter clip."
        )));
    }
    if let Some(error) = stdout.read_error.as_ref().or(stderr.read_error.as_ref()) {
        return Err(AppError::TranscriptionFailed(format!(
            "Could not read {tool} output: {error}"
        )));
    }
    on_stdout(&stdout.bytes[consumed..]);
    Ok(ProcessOutput {
        status,
        stdout: std::mem::take(&mut stdout.bytes),
        stderr: String::from_utf8_lossy(&stderr.bytes).trim().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::runner;

    fn child(mode: &str) -> Command {
        let mut command = runner::command(&std::env::current_exe().unwrap());
        command.args([
            "--exact",
            "transcription::process::tests::child_fixture",
            "--ignored",
            "--nocapture",
        ]);
        command.env("REEL_TRANSCRIPTION_TEST_CHILD", mode);
        command
    }

    #[test]
    #[ignore = "subprocess fixture invoked only by the process tests"]
    fn child_fixture() {
        match std::env::var("REEL_TRANSCRIPTION_TEST_CHILD").as_deref() {
            Ok("large") => println!("{}", "x".repeat(100_000)),
            Ok("silent") => thread::sleep(Duration::from_secs(10)),
            _ => panic!("fixture requires a test mode"),
        }
    }

    #[test]
    fn bounds_captured_output() {
        let error = run(
            &mut child("large"),
            "test",
            &CancelToken::new(),
            Duration::from_secs(5),
            1024,
            &mut |_| {},
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("output limit"));
    }

    #[test]
    fn cancels_a_silent_child_without_waiting_for_output() {
        let token = CancelToken::new();
        let cancel = token.clone();
        let thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(100));
            cancel.cancel();
        });
        let started = Instant::now();
        let error = run(
            &mut child("silent"),
            "test",
            &token,
            Duration::from_secs(5),
            1024,
            &mut |_| {},
        )
        .err()
        .unwrap();
        thread.join().unwrap();
        assert_eq!(error.kind(), "job_cancelled");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn times_out_a_silent_child() {
        let error = run(
            &mut child("silent"),
            "test",
            &CancelToken::new(),
            Duration::from_millis(150),
            1024,
            &mut |_| {},
        )
        .err()
        .unwrap();
        assert!(error.to_string().contains("timed out"));
    }
}
