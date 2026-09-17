use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tracing::{debug, info};

use crate::error::{AppError, AppResult};
use crate::logging::category;
use crate::media::runner::command;

#[cfg(windows)]
pub const FFMPEG_EXE: &str = "ffmpeg.exe";
#[cfg(windows)]
pub const FFPROBE_EXE: &str = "ffprobe.exe";
#[cfg(not(windows))]
pub const FFMPEG_EXE: &str = "ffmpeg";
#[cfg(not(windows))]
pub const FFPROBE_EXE: &str = "ffprobe";

/// Where a working FFmpeg pair was found. Surfaced in the UI so the user can tell a configured
/// binary from one that happened to be on `PATH`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolSource {
    /// Explicitly chosen by the user and persisted in app settings.
    Configured,
    /// `FFMPEG_PATH` environment variable.
    Environment,
    /// Shipped next to the application executable.
    Bundled,
    /// Found by scanning `PATH`.
    SystemPath,
    /// A well-known Windows installation directory.
    WellKnown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
    pub source: ToolSource,
}

/// Everything discovery is allowed to look at. Passed in rather than read from the process so
/// the ordering rules are testable without touching the machine's real environment.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryInputs {
    pub configured_ffmpeg: Option<PathBuf>,
    pub configured_ffprobe: Option<PathBuf>,
    pub env_ffmpeg: Option<PathBuf>,
    pub bundled_dir: Option<PathBuf>,
    pub path_dirs: Vec<PathBuf>,
    pub well_known_dirs: Vec<PathBuf>,
}

impl DiscoveryInputs {
    /// Reads the real environment: `FFMPEG_PATH`, `PATH`, and the usual Windows install roots.
    pub fn from_environment(
        configured_ffmpeg: Option<PathBuf>,
        configured_ffprobe: Option<PathBuf>,
        bundled_dir: Option<PathBuf>,
    ) -> Self {
        let path_dirs = std::env::var_os("PATH")
            .map(|value| std::env::split_paths(&value).collect())
            .unwrap_or_default();

        Self {
            configured_ffmpeg,
            configured_ffprobe,
            env_ffmpeg: std::env::var_os("FFMPEG_PATH").map(PathBuf::from),
            bundled_dir,
            path_dirs,
            well_known_dirs: well_known_dirs(),
        }
    }
}

/// Standard Windows locations used by winget, Chocolatey, Scoop and manual installs.
#[cfg(windows)]
fn well_known_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push = |base: Option<std::ffi::OsString>, tail: &[&str]| {
        if let Some(base) = base {
            let mut dir = PathBuf::from(base);
            dir.extend(tail);
            dirs.push(dir);
        }
    };

    push(std::env::var_os("ProgramFiles"), &["ffmpeg", "bin"]);
    push(std::env::var_os("ProgramFiles(x86)"), &["ffmpeg", "bin"]);
    push(std::env::var_os("ProgramData"), &["chocolatey", "bin"]);
    push(
        std::env::var_os("LOCALAPPDATA"),
        &["Microsoft", "WinGet", "Links"],
    );
    push(std::env::var_os("USERPROFILE"), &["scoop", "shims"]);
    dirs
}

#[cfg(not(windows))]
fn well_known_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/usr/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/opt/homebrew/bin"),
    ]
}

/// Given a path that may be either the `ffmpeg` binary itself or the directory containing it,
/// returns the binary path.
fn as_binary(path: &Path, exe: &str) -> PathBuf {
    // A configured value pointing at a directory is a common user mistake; accept both.
    if path
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case(std::ffi::OsStr::new(exe)))
    {
        path.to_path_buf()
    } else {
        path.join(exe)
    }
}

/// Infers the `ffprobe` path that belongs with a given `ffmpeg` path. They ship side by side in
/// every distribution, so an explicit ffprobe setting is only needed for unusual layouts.
fn sibling_ffprobe(ffmpeg: &Path) -> PathBuf {
    ffmpeg
        .parent()
        .map(|dir| dir.join(FFPROBE_EXE))
        .unwrap_or_else(|| PathBuf::from(FFPROBE_EXE))
}

/// Ordered, de-duplicated list of places to try. Highest precedence first: an explicit user
/// setting always wins over whatever happens to be installed on the machine.
pub fn candidates(inputs: &DiscoveryInputs) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();

    let mut push = |ffmpeg: PathBuf, ffprobe: Option<PathBuf>, source: ToolSource| {
        let ffprobe = ffprobe.unwrap_or_else(|| sibling_ffprobe(&ffmpeg));
        let candidate = Candidate {
            ffmpeg,
            ffprobe,
            source,
        };
        if !candidates.iter().any(|existing| {
            existing.ffmpeg == candidate.ffmpeg && existing.ffprobe == candidate.ffprobe
        }) {
            candidates.push(candidate);
        }
    };

    if let Some(configured) = &inputs.configured_ffmpeg {
        let ffmpeg = as_binary(configured, FFMPEG_EXE);
        let ffprobe = inputs
            .configured_ffprobe
            .as_ref()
            .map(|path| as_binary(path, FFPROBE_EXE));
        push(ffmpeg, ffprobe, ToolSource::Configured);
    }

    if let Some(from_env) = &inputs.env_ffmpeg {
        push(
            as_binary(from_env, FFMPEG_EXE),
            None,
            ToolSource::Environment,
        );
    }

    if let Some(bundled) = &inputs.bundled_dir {
        push(bundled.join(FFMPEG_EXE), None, ToolSource::Bundled);
    }

    for dir in &inputs.path_dirs {
        push(dir.join(FFMPEG_EXE), None, ToolSource::SystemPath);
    }

    for dir in &inputs.well_known_dirs {
        push(dir.join(FFMPEG_EXE), None, ToolSource::WellKnown);
    }

    candidates
}

/// Picks the first candidate whose `ffmpeg` and `ffprobe` both exist, using the supplied
/// existence predicate.
pub fn first_present<F>(candidates: &[Candidate], exists: F) -> Option<Candidate>
where
    F: Fn(&Path) -> bool,
{
    candidates
        .iter()
        .find(|candidate| exists(&candidate.ffmpeg) && exists(&candidate.ffprobe))
        .cloned()
}

/// A verified, ready-to-use FFmpeg installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegTools {
    pub ffmpeg_path: String,
    pub ffprobe_path: String,
    pub version: String,
    pub source: ToolSource,
}

impl FfmpegTools {
    pub fn ffmpeg(&self) -> &Path {
        Path::new(&self.ffmpeg_path)
    }

    pub fn ffprobe(&self) -> &Path {
        Path::new(&self.ffprobe_path)
    }
}

/// Extracts the human-readable version from `ffmpeg -version` output.
pub fn parse_version(stdout: &str) -> Option<String> {
    let first_line = stdout.lines().next()?.trim();
    if !first_line.starts_with("ffmpeg version") {
        return None;
    }
    first_line
        .split_whitespace()
        .nth(2)
        .map(str::to_string)
        .filter(|version| !version.is_empty())
}

fn query_version(ffmpeg: &Path) -> AppResult<String> {
    let output = command(ffmpeg).arg("-version").output().map_err(|error| {
        AppError::FfmpegUnavailable(format!("could not run {}: {error}", ffmpeg.display()))
    })?;

    if !output.status.success() {
        return Err(AppError::FfmpegUnavailable(format!(
            "{} -version exited with {}",
            ffmpeg.display(),
            output.status
        )));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_version(&stdout).ok_or_else(|| {
        AppError::FfmpegUnavailable(format!(
            "{} did not report a recognizable version",
            ffmpeg.display()
        ))
    })
}

/// Full resolution: enumerate candidates, keep the first that exists on disk, then confirm it
/// actually runs. Returns `FfmpegUnavailable` with the searched locations when nothing works.
pub fn resolve(inputs: &DiscoveryInputs) -> AppResult<FfmpegTools> {
    let candidates = candidates(inputs);
    debug!(
        target: category::MEDIA,
        count = candidates.len(),
        "searching for ffmpeg"
    );

    let Some(candidate) = first_present(&candidates, |path| path.is_file()) else {
        let searched = candidates
            .iter()
            .take(8)
            .map(|c| c.ffmpeg.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(AppError::FfmpegUnavailable(format!(
            "ffmpeg.exe and ffprobe.exe were not found. Searched: {searched}"
        )));
    };

    let version = query_version(&candidate.ffmpeg)?;
    info!(
        target: category::MEDIA,
        ffmpeg = %candidate.ffmpeg.display(),
        version = %version,
        source = ?candidate.source,
        "ffmpeg resolved"
    );

    Ok(FfmpegTools {
        ffmpeg_path: candidate.ffmpeg.to_string_lossy().into_owned(),
        ffprobe_path: candidate.ffprobe.to_string_lossy().into_owned(),
        version,
        source: candidate.source,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn dir(path: &str) -> PathBuf {
        PathBuf::from(path)
    }

    #[test]
    fn configured_path_wins_over_everything_else() {
        let inputs = DiscoveryInputs {
            configured_ffmpeg: Some(dir(r"D:\tools\ffmpeg\bin")),
            env_ffmpeg: Some(dir(r"D:\env")),
            bundled_dir: Some(dir(r"D:\app\binaries")),
            path_dirs: vec![dir(r"C:\Windows\System32")],
            well_known_dirs: vec![dir(r"C:\Program Files\ffmpeg\bin")],
            ..Default::default()
        };

        let first = &candidates(&inputs)[0];
        assert_eq!(first.source, ToolSource::Configured);
        assert_eq!(first.ffmpeg, dir(r"D:\tools\ffmpeg\bin").join(FFMPEG_EXE));
    }

    #[test]
    fn precedence_order_is_configured_env_bundled_path_wellknown() {
        let inputs = DiscoveryInputs {
            configured_ffmpeg: Some(dir(r"D:\configured")),
            env_ffmpeg: Some(dir(r"D:\env")),
            bundled_dir: Some(dir(r"D:\bundled")),
            path_dirs: vec![dir(r"D:\path")],
            well_known_dirs: vec![dir(r"D:\wellknown")],
            ..Default::default()
        };

        let sources: Vec<ToolSource> = candidates(&inputs).iter().map(|c| c.source).collect();
        assert_eq!(
            sources,
            vec![
                ToolSource::Configured,
                ToolSource::Environment,
                ToolSource::Bundled,
                ToolSource::SystemPath,
                ToolSource::WellKnown,
            ]
        );
    }

    #[test]
    fn a_configured_binary_path_is_accepted_as_well_as_a_directory() {
        let as_file = DiscoveryInputs {
            configured_ffmpeg: Some(dir(r"D:\tools\bin").join(FFMPEG_EXE)),
            ..Default::default()
        };
        let as_directory = DiscoveryInputs {
            configured_ffmpeg: Some(dir(r"D:\tools\bin")),
            ..Default::default()
        };

        assert_eq!(
            candidates(&as_file)[0].ffmpeg,
            candidates(&as_directory)[0].ffmpeg
        );
    }

    #[test]
    fn ffprobe_defaults_to_the_ffmpeg_sibling() {
        let inputs = DiscoveryInputs {
            configured_ffmpeg: Some(dir(r"D:\tools\bin")),
            ..Default::default()
        };
        let candidate = &candidates(&inputs)[0];
        assert_eq!(candidate.ffprobe, dir(r"D:\tools\bin").join(FFPROBE_EXE));
    }

    #[test]
    fn an_explicit_ffprobe_setting_overrides_the_sibling_guess() {
        let inputs = DiscoveryInputs {
            configured_ffmpeg: Some(dir(r"D:\a\bin")),
            configured_ffprobe: Some(dir(r"D:\b\bin")),
            ..Default::default()
        };
        let candidate = &candidates(&inputs)[0];
        assert_eq!(candidate.ffmpeg, dir(r"D:\a\bin").join(FFMPEG_EXE));
        assert_eq!(candidate.ffprobe, dir(r"D:\b\bin").join(FFPROBE_EXE));
    }

    #[test]
    fn duplicate_directories_are_collapsed() {
        let inputs = DiscoveryInputs {
            path_dirs: vec![dir(r"D:\same"), dir(r"D:\same"), dir(r"D:\other")],
            well_known_dirs: vec![dir(r"D:\same")],
            ..Default::default()
        };

        let found = candidates(&inputs);
        let unique: HashSet<&PathBuf> = found.iter().map(|c| &c.ffmpeg).collect();
        assert_eq!(found.len(), unique.len());
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn no_inputs_yields_no_candidates() {
        assert!(candidates(&DiscoveryInputs::default()).is_empty());
    }

    #[test]
    fn first_present_skips_candidates_missing_ffprobe() {
        let inputs = DiscoveryInputs {
            path_dirs: vec![dir(r"D:\ffmpeg-only"), dir(r"D:\complete")],
            ..Default::default()
        };
        let found = candidates(&inputs);

        // `D:\ffmpeg-only` has ffmpeg but no ffprobe, so it must be skipped.
        let selected = first_present(&found, |path| {
            path.starts_with(r"D:\complete")
                || path.file_name() == Some(std::ffi::OsStr::new(FFMPEG_EXE))
        })
        .expect("a complete candidate exists");

        assert!(selected.ffmpeg.starts_with(r"D:\complete"));
    }

    #[test]
    fn first_present_returns_none_when_nothing_exists() {
        let inputs = DiscoveryInputs {
            path_dirs: vec![dir(r"D:\nowhere")],
            ..Default::default()
        };
        assert!(first_present(&candidates(&inputs), |_| false).is_none());
    }

    #[test]
    fn parses_a_real_version_banner() {
        let banner = "ffmpeg version 7.1.1-full_build-www.gyan.dev Copyright (c) 2000-2025\n\
                      built with gcc 14.2.0";
        assert_eq!(
            parse_version(banner).as_deref(),
            Some("7.1.1-full_build-www.gyan.dev")
        );
    }

    #[test]
    fn parses_a_distribution_version_banner() {
        let banner = "ffmpeg version 6.1.1-3ubuntu5 Copyright (c) 2000-2023 the FFmpeg developers";
        assert_eq!(parse_version(banner).as_deref(), Some("6.1.1-3ubuntu5"));
    }

    #[test]
    fn rejects_output_that_is_not_ffmpeg() {
        assert_eq!(parse_version("Python 3.12.1"), None);
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("ffmpeg version"), None);
    }

    #[test]
    fn resolve_reports_where_it_looked_when_nothing_is_installed() {
        let inputs = DiscoveryInputs {
            path_dirs: vec![dir(r"D:\definitely-not-here")],
            ..Default::default()
        };
        let error = resolve(&inputs).expect_err("nothing installed");
        assert_eq!(error.kind(), "ffmpeg_unavailable");
        assert!(error.to_string().contains("definitely-not-here"));
    }
}
