//! Native, application-wide speech setup and a bounded offline readiness check.
use std::path::Path;
use std::time::Duration;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::media::runner::{self, CancelToken};
use crate::timeline::invalid;

const PROBE: &str = include_str!("setup_probe.py");
const PROBE_LIMIT: usize = 32 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptionSetup {
    pub python_path: String,
    pub model_path: String,
    pub language: String,
}

pub(super) fn normalize_path(value: &str, label: &str) -> AppResult<String> {
    if value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(invalid(&format!(
            "{label} path must be at most 4096 bytes and contain no control characters"
        )));
    }
    Ok(value.trim().to_string())
}

impl TranscriptionSetup {
    /// Missing paths are valid saved drafts; readiness is checked separately.
    pub fn normalize(mut self) -> AppResult<Self> {
        self.python_path = normalize_path(&self.python_path, "Python executable")?;
        if self.python_path.is_empty() {
            self.python_path = "python".into();
        }
        self.model_path = normalize_path(&self.model_path, "model folder")?;
        if !["auto", "en", "ar"].contains(&self.language.as_str()) {
            return Err(invalid("transcription language must be auto, en, or ar"));
        }
        Ok(self)
    }
}

pub fn get(conn: &Connection) -> AppResult<Option<TranscriptionSetup>> {
    let Some(value) = settings::get(conn, settings::keys::TRANSCRIPTION_SETUP)? else {
        return Ok(None);
    };
    let recover = || {
        invalid("Saved transcription setup is invalid. Choose the Python executable and local model again, then save setup.")
    };
    serde_json::from_str::<TranscriptionSetup>(&value)
        .map_err(|_| recover())?
        .normalize()
        .map(Some)
        .map_err(|_| recover())
}

pub fn save(conn: &Connection, setup: TranscriptionSetup) -> AppResult<TranscriptionSetup> {
    let setup = setup.normalize()?;
    settings::set(
        conn,
        settings::keys::TRANSCRIPTION_SETUP,
        &serde_json::to_string(&setup)?,
    )?;
    Ok(setup)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptionReadiness {
    pub ready: bool,
    pub python_version: Option<String>,
    pub provider_version: Option<String>,
    pub model_ready: bool,
    pub ffmpeg_ready: bool,
    pub multilingual: Option<bool>,
    pub issues: Vec<String>,
}

impl TranscriptionReadiness {
    pub fn new(ffmpeg_issue: Option<String>) -> Self {
        Self {
            ready: false,
            python_version: None,
            provider_version: None,
            model_ready: false,
            ffmpeg_ready: ffmpeg_issue.is_none(),
            multilingual: None,
            issues: ffmpeg_issue.into_iter().collect(),
        }
    }

    fn apply_probe(&mut self, probe: ProbeResult, language: &str) {
        self.python_version = probe.python_version;
        self.provider_version = probe.provider_version;
        self.model_ready = probe.model_ready;
        self.multilingual = probe.multilingual;
        self.issues.extend(probe.issues);
        if language == "ar" && self.multilingual == Some(false) {
            self.issues.push("The selected model supports English only. Choose a multilingual Whisper model for Arabic captions.".into());
        }
        self.ready = self.issues.is_empty()
            && self.ffmpeg_ready
            && self.model_ready
            && self.python_version.is_some()
            && self.provider_version.is_some()
            && self.multilingual.is_some();
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProbeResult {
    python_version: Option<String>,
    provider_version: Option<String>,
    model_ready: bool,
    multilingual: Option<bool>,
    issues: Vec<String>,
}

fn parse_probe(stdout: &[u8]) -> AppResult<ProbeResult> {
    let invalid_probe = || {
        AppError::TranscriptionUnavailable("The selected Python executable returned an invalid setup result. Choose a Python 3.9 or newer environment with faster-whisper installed.".into())
    };
    let result: ProbeResult = serde_json::from_slice(stdout).map_err(|_| invalid_probe())?;
    let valid_version = |value: &Option<String>| {
        value.as_ref().is_none_or(|value| {
            !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
        })
    };
    if !valid_version(&result.python_version)
        || !valid_version(&result.provider_version)
        || result.issues.len() > 16
        || result
            .issues
            .iter()
            .any(|issue| issue.is_empty() || issue.len() > 4096)
        || (result.model_ready
            && (result.multilingual.is_none()
                || result.python_version.is_none()
                || result.provider_version.is_none()))
        || (!result.model_ready && result.multilingual.is_some())
    {
        return Err(invalid_probe());
    }
    Ok(result)
}

/// Call only while holding the shared model slot, on a blocking worker thread.
pub fn check(
    setup: &TranscriptionSetup,
    mut status: TranscriptionReadiness,
) -> TranscriptionReadiness {
    let model = match super::local_model_path(&setup.model_path) {
        Ok(path) => Some(path),
        Err(error) => {
            status.issues.push(error.to_string());
            None
        }
    };
    let mut command = runner::command(Path::new(&setup.python_path));
    command.args(["-I", "-u", "-c", PROBE]);
    command.arg(model.as_deref().unwrap_or_else(|| Path::new("")));
    let output = super::process::run(
        &mut command,
        "Transcription setup check",
        &CancelToken::new(),
        Duration::from_secs(60),
        PROBE_LIMIT,
        &mut |_| {},
    );
    match output {
        Ok(output) => match parse_probe(&output.stdout) {
            Ok(probe) => {
                status.apply_probe(probe, &setup.language);
                if !output.status.success() {
                    status.ready = false;
                    status.issues.push(format!("The Python setup check exited with {}. Verify the selected Python environment and local model.", output.status));
                }
            }
            Err(error) => status.issues.push(error.to_string()),
        },
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            status.issues.push("Python was not found. Choose a Python 3.9 or newer executable from an environment with faster-whisper installed.".into());
        }
        Err(error) => status.issues.push(format!(
            "{error} Check the selected Python executable and local model, then retry."
        )),
    }
    status
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_app_db_in_memory;

    fn setup() -> TranscriptionSetup {
        TranscriptionSetup {
            python_path: "python".into(),
            model_path: "".into(),
            language: "auto".into(),
        }
    }

    #[test]
    fn setup_normalizes_paths_and_preserves_incomplete_drafts() {
        let normalized = TranscriptionSetup {
            python_path: "  ".into(),
            model_path: "  C:\\my model  ".into(),
            language: "ar".into(),
        }
        .normalize()
        .unwrap();
        assert_eq!(normalized.python_path, "python");
        assert_eq!(normalized.model_path, r"C:\my model");
        assert_eq!(setup().normalize().unwrap().model_path, "");
    }

    #[test]
    fn setup_rejects_unknown_languages_and_unsafe_or_oversize_paths() {
        for path in [
            "x\0y".into(),
            "\tx".into(),
            "x\ny".into(),
            "x\u{7f}y".into(),
            "a".repeat(4097),
        ] {
            let mut input = setup();
            input.python_path = path.clone();
            assert!(input.normalize().is_err());
            let mut input = setup();
            input.model_path = path;
            assert!(input.normalize().is_err());
        }
        let mut input = setup();
        input.language = "fr".into();
        assert!(input.normalize().is_err());
    }

    #[test]
    fn setup_round_trips_as_one_atomic_setting_and_failed_save_preserves_it() {
        let conn = open_app_db_in_memory().unwrap();
        assert_eq!(get(&conn).unwrap(), None);
        let original = save(&conn, setup()).unwrap();
        assert_eq!(get(&conn).unwrap(), Some(original.clone()));
        assert_eq!(settings::all(&conn).unwrap().len(), 1);
        let mut invalid = original.clone();
        invalid.language = "invalid".into();
        assert!(save(&conn, invalid).is_err());
        assert_eq!(get(&conn).unwrap(), Some(original));
        let changed = TranscriptionSetup {
            language: "en".into(),
            ..setup()
        };
        save(&conn, changed.clone()).unwrap();
        assert_eq!(get(&conn).unwrap(), Some(changed));
        assert_eq!(settings::all(&conn).unwrap().len(), 1);
    }

    #[test]
    fn malformed_saved_setup_is_actionable_and_can_be_replaced() {
        let conn = open_app_db_in_memory().unwrap();
        for raw in [
            "not json",
            "{}",
            r#"{"pythonPath":"python","modelPath":"","language":"fr"}"#,
        ] {
            settings::set(&conn, settings::keys::TRANSCRIPTION_SETUP, raw).unwrap();
            let error = get(&conn).unwrap_err();
            assert_eq!(error.kind(), "invalid_input");
            assert!(error.to_string().contains("then save setup"));
        }
        save(&conn, setup()).unwrap();
        assert!(get(&conn).unwrap().is_some());
    }

    fn ready_probe(multilingual: bool) -> ProbeResult {
        ProbeResult {
            python_version: Some("3.13.0".into()),
            provider_version: Some("1.2.0".into()),
            model_ready: true,
            multilingual: Some(multilingual),
            issues: vec![],
        }
    }

    #[test]
    fn readiness_requires_tools_and_an_arabic_compatible_model() {
        let mut status = TranscriptionReadiness::new(None);
        status.apply_probe(ready_probe(true), "ar");
        assert!(status.ready);
        let mut status = TranscriptionReadiness::new(None);
        status.apply_probe(ready_probe(false), "ar");
        assert!(!status.ready);
        assert!(status.issues[0].contains("English only"));
        for language in ["en", "auto"] {
            let mut status = TranscriptionReadiness::new(None);
            status.apply_probe(ready_probe(false), language);
            assert!(status.ready);
        }
        let mut status = TranscriptionReadiness::new(Some("Set up FFmpeg".into()));
        status.apply_probe(ready_probe(true), "auto");
        assert!(!status.ready);
        assert!(!status.ffmpeg_ready);
    }

    #[test]
    fn probe_parser_rejects_pollution_multiple_results_and_inconsistent_fields() {
        let good = r#"{"pythonVersion":"3.13.0","providerVersion":"1.2.0","modelReady":true,"multilingual":true,"issues":[]}"#;
        assert!(parse_probe(good.as_bytes()).is_ok());
        for bad in [
            format!("debug\n{good}"),
            format!("{good}\n{good}"),
            good.replace("\"multilingual\":true", "\"multilingual\":null"),
            good.replace("\"providerVersion\":\"1.2.0\"", "\"providerVersion\":null"),
            "{}".into(),
        ] {
            assert!(parse_probe(bad.as_bytes()).is_err());
        }
        let missing = br#"{"pythonVersion":"3.13.0","providerVersion":null,"modelReady":false,"multilingual":null,"issues":["Install faster-whisper"]}"#;
        let probe = parse_probe(missing).unwrap();
        assert_eq!(probe.issues, ["Install faster-whisper"]);
    }

    #[test]
    fn missing_python_and_model_return_actionable_readiness_without_throwing() {
        let dir = tempfile::tempdir().unwrap();
        let input = TranscriptionSetup {
            python_path: dir
                .path()
                .join("missing-python.exe")
                .to_string_lossy()
                .into_owned(),
            ..setup()
        };
        let status = check(&input, TranscriptionReadiness::new(None));
        assert!(!status.ready);
        assert_eq!(status.python_version, None);
        assert!(!status.model_ready);
        assert!(status
            .issues
            .iter()
            .any(|issue| issue.contains("Python was not found")));
        assert!(status
            .issues
            .iter()
            .any(|issue| issue.contains("model.bin")));
    }
}
