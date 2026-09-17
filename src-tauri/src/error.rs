use std::path::PathBuf;

use serde::ser::{SerializeStruct, Serializer};
use serde::{Deserialize, Serialize};

/// Every failure that can cross the IPC boundary.
///
/// Serialized as `{ kind, message }` so the frontend can branch on a stable machine code instead
/// of pattern-matching human-readable text (spec §29: never silently fail, always actionable).
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),

    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),

    #[error("serialization error: {0}")]
    Serde(#[from] serde_json::Error),

    #[error("{0}")]
    FfmpegUnavailable(String),

    #[error("{tool} failed ({code}): {stderr}")]
    ToolFailed {
        tool: String,
        code: String,
        stderr: String,
    },

    #[error("media file not found: {}", .0.display())]
    MediaFileNotFound(PathBuf),

    #[error("unsupported media: {0}")]
    UnsupportedMedia(String),

    #[error("project not found: {0}")]
    ProjectNotFound(String),

    #[error("media asset not found: {0}")]
    MediaAssetNotFound(String),

    #[error("no project is currently open")]
    NoProjectOpen,

    #[error("job was cancelled")]
    JobCancelled,

    #[error("job not found: {0}")]
    JobNotFound(String),

    #[error("invalid input: {0}")]
    InvalidInput(String),

    #[error("{0}")]
    Internal(String),
}

impl AppError {
    /// Stable machine-readable discriminant. Never change these strings without updating
    /// `src/domain/shared/errors.ts`.
    pub fn kind(&self) -> &'static str {
        match self {
            AppError::Database(_) => "database",
            AppError::Io(_) => "io",
            AppError::Serde(_) => "serde",
            AppError::FfmpegUnavailable(_) => "ffmpeg_unavailable",
            AppError::ToolFailed { .. } => "tool_failed",
            AppError::MediaFileNotFound(_) => "media_file_not_found",
            AppError::UnsupportedMedia(_) => "unsupported_media",
            AppError::ProjectNotFound(_) => "project_not_found",
            AppError::MediaAssetNotFound(_) => "media_asset_not_found",
            AppError::NoProjectOpen => "no_project_open",
            AppError::JobCancelled => "job_cancelled",
            AppError::JobNotFound(_) => "job_not_found",
            AppError::InvalidInput(_) => "invalid_input",
            AppError::Internal(_) => "internal",
        }
    }

    /// True when retrying the same operation could plausibly succeed (spec §29 retry affordance).
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            AppError::Io(_) | AppError::ToolFailed { .. } | AppError::Internal(_)
        )
    }
}

/// The serializable error envelope crossing IPC (spec §29).
///
/// The single definition shared by failed commands and failed jobs, in Rust and in the frontend
/// (`src/domain/errors.ts`), so the two can never drift apart.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorEnvelope {
    pub kind: String,
    pub message: String,
    pub retryable: bool,
}

impl From<&AppError> for ErrorEnvelope {
    fn from(error: &AppError) -> Self {
        Self {
            kind: error.kind().to_string(),
            message: error.to_string(),
            retryable: error.is_retryable(),
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let envelope = ErrorEnvelope::from(self);
        let mut state = serializer.serialize_struct("AppError", 3)?;
        state.serialize_field("kind", &envelope.kind)?;
        state.serialize_field("message", &envelope.message)?;
        state.serialize_field("retryable", &envelope.retryable)?;
        state.end()
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        AppError::Internal(value.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_kind_message_and_retryable() {
        let err = AppError::FfmpegUnavailable("not on PATH".into());
        let json = serde_json::to_value(&err).expect("serializable");
        assert_eq!(json["kind"], "ffmpeg_unavailable");
        assert_eq!(json["retryable"], false);
        assert!(json["message"]
            .as_str()
            .expect("message is a string")
            .contains("not on PATH"));
    }

    #[test]
    fn tool_failures_are_retryable() {
        let err = AppError::ToolFailed {
            tool: "ffmpeg".into(),
            code: "1".into(),
            stderr: "boom".into(),
        };
        assert!(err.is_retryable());
        assert_eq!(err.kind(), "tool_failed");
    }

    #[test]
    fn missing_input_is_not_retryable() {
        assert!(!AppError::InvalidInput("empty name".into()).is_retryable());
    }

    #[test]
    fn the_envelope_matches_the_serialized_error() {
        let error = AppError::ToolFailed {
            tool: "ffmpeg".into(),
            code: "1".into(),
            stderr: "boom".into(),
        };
        let envelope = ErrorEnvelope::from(&error);
        let json = serde_json::to_value(&error).expect("serializable");

        assert_eq!(json["kind"], envelope.kind);
        assert_eq!(json["message"], envelope.message);
        assert_eq!(json["retryable"], envelope.retryable);
    }
}
