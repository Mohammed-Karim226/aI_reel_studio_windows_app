//! System commands: app info, settings, FFmpeg resolution, and diagnostics (spec §30, §31, §34).

use std::collections::BTreeMap;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::logging::LogRecord;
use crate::media::ffmpeg::FfmpegTools;
use crate::state::AppState;
use crate::AppInfo;

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    crate::current_app_info()
}

/// Raw settings map. The diagnostics and settings panels land in a later phase; the command is
/// part of the reviewed IPC surface.
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> AppResult<BTreeMap<String, String>> {
    let conn = state.app_db();
    settings::all(&conn)
}

#[tauri::command]
pub fn set_setting(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    let conn = state.app_db();
    settings::set(&conn, &key, &value)?;
    drop(conn);

    // A changed FFmpeg location invalidates the cached installation immediately.
    if key == settings::keys::FFMPEG_PATH || key == settings::keys::FFPROBE_PATH {
        state.clear_ffmpeg_cache();
    }
    Ok(())
}

#[tauri::command]
pub fn remove_setting(state: State<'_, AppState>, key: String) -> AppResult<()> {
    let conn = state.app_db();
    settings::remove(&conn, &key)?;
    drop(conn);

    if key == settings::keys::FFMPEG_PATH || key == settings::keys::FFPROBE_PATH {
        state.clear_ffmpeg_cache();
    }
    Ok(())
}

/// Whether FFmpeg is usable right now, where it came from, and why not when it is missing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    pub tools: Option<FfmpegTools>,
    pub error: Option<String>,
}

fn status_of(state: &AppState) -> FfmpegStatus {
    match state.ffmpeg() {
        Ok(tools) => FfmpegStatus {
            available: true,
            tools: Some(tools),
            error: None,
        },
        Err(error) => FfmpegStatus {
            available: false,
            tools: None,
            error: Some(error.to_string()),
        },
    }
}

/// Reports the current FFmpeg installation. `refresh` forces a fresh discovery pass.
///
/// Discovery spawns `ffmpeg -version`, so it runs on a blocking thread pool rather than on the
/// thread that reads WebView messages.
#[tauri::command]
pub async fn resolve_ffmpeg(app: AppHandle, refresh: Option<bool>) -> AppResult<FfmpegStatus> {
    if refresh.unwrap_or(false) {
        app.state::<AppState>().clear_ffmpeg_cache();
    }

    let status = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        status_of(&state)
    })
    .await?;

    Ok(status)
}

/// Stores an explicitly chosen FFmpeg binary (spec §34) and reports whether it works.
#[tauri::command]
pub async fn configure_ffmpeg(
    app: AppHandle,
    ffmpeg_path: String,
    ffprobe_path: Option<String>,
) -> AppResult<FfmpegStatus> {
    let status = tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        configure_and_report(&state, &ffmpeg_path, ffprobe_path.as_deref())
    })
    .await??;

    Ok(status)
}

fn configure_and_report(
    state: &AppState,
    ffmpeg_path: &str,
    ffprobe_path: Option<&str>,
) -> AppResult<FfmpegStatus> {
    let ffmpeg = ffmpeg_path.trim();
    if ffmpeg.is_empty() {
        return Err(AppError::InvalidInput("no FFmpeg path was given".into()));
    }

    {
        let conn = state.app_db();
        settings::set(&conn, settings::keys::FFMPEG_PATH, ffmpeg)?;

        match ffprobe_path.map(str::trim) {
            Some(ffprobe) if !ffprobe.is_empty() => {
                settings::set(&conn, settings::keys::FFPROBE_PATH, ffprobe)?;
            }
            // Clearing the setting lets discovery infer ffprobe from the ffmpeg sibling.
            _ => settings::remove(&conn, settings::keys::FFPROBE_PATH)?,
        }
    }

    state.clear_ffmpeg_cache();
    Ok(status_of(state))
}

/// Recent structured log records for the developer diagnostics panel (spec §30).
#[tauri::command]
pub fn recent_logs(
    _state: State<'_, AppState>,
    limit: Option<usize>,
    category: Option<String>,
) -> Vec<LogRecord> {
    let ring = crate::logging::log_ring();
    ring.recent(limit.unwrap_or(200), category.as_deref())
}

/// Directory offered when the user creates a project without choosing one.
#[tauri::command]
pub fn default_projects_dir(state: State<'_, AppState>) -> String {
    state
        .paths()
        .default_projects_dir
        .to_string_lossy()
        .into_owned()
}
