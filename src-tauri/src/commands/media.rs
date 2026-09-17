//! Media library commands: import, inspect, regenerate derivatives (spec §4.3, §28, §29).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::db::media as media_db;
use crate::error::{AppError, AppResult};
use crate::jobs::pipeline;
use crate::media::engine::{self, DerivativePlan};
use crate::media::ffmpeg::FfmpegTools;
use crate::media::probe::ProbeResult;
use crate::media::types::{DerivativeKind, DerivativeStatus, MediaAsset};
use crate::media::waveform::WaveformData;
use crate::project;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedImport {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOutcome {
    pub imported: Vec<MediaAsset>,
    pub skipped: Vec<SkippedImport>,
}

/// What can be generated for one asset, and why not when it cannot (spec §42: a control must
/// either work or clearly say it is unavailable).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DerivativePlanView {
    pub kind: DerivativeKind,
    pub applicable: bool,
    pub reason: Option<String>,
    pub params: serde_json::Value,
}

fn probe_blocking(tools: &FfmpegTools, path: &Path) -> AppResult<ProbeResult> {
    crate::media::probe::probe_file(tools, path)
}

/// Imports files into the open project.
///
/// Probing runs on a blocking thread pool so a long import never freezes the window (spec §28);
/// the database writes themselves are short and stay on the command thread.
#[tauri::command]
pub async fn import_media(
    app: AppHandle,
    state: State<'_, AppState>,
    paths: Vec<String>,
) -> AppResult<ImportOutcome> {
    if paths.is_empty() {
        return Err(AppError::InvalidInput("no files were selected".into()));
    }

    // Fail before touching anything if derivatives could never be produced (spec §29).
    let tools = state.ffmpeg()?;
    state.project_root()?;
    // Derivative tunables live in the application database, never in the project database.
    let options = pipeline::derivative_options(&state.app_db())?;

    let mut outcome = ImportOutcome {
        imported: Vec::new(),
        skipped: Vec::new(),
    };

    for raw_path in paths {
        let path = PathBuf::from(raw_path.trim());
        if path.as_os_str().is_empty() {
            continue;
        }

        // Re-importing a file that is already in the library is a no-op, not an error.
        let existing = state.with_project(|project| {
            media_db::find_asset_id_by_path(&project.db, &path.to_string_lossy())
        })?;
        if let Some(asset_id) = existing {
            let asset =
                state.with_project(|project| media_db::get_asset(&project.db, &asset_id))?;
            outcome.imported.push(asset);
            continue;
        }

        let probe = {
            let tools = tools.clone();
            let path = path.clone();
            tauri::async_runtime::spawn_blocking(move || probe_blocking(&tools, &path)).await?
        };

        let probe = match probe {
            Ok(probe) => probe,
            Err(error) => {
                outcome.skipped.push(SkippedImport {
                    path: path.to_string_lossy().into_owned(),
                    reason: error.to_string(),
                });
                continue;
            }
        };

        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        let asset_id = uuid::Uuid::new_v4().to_string();
        let original_path = path.to_string_lossy().into_owned();
        let jobs = state.jobs();

        let asset = state.with_project(|project| {
            media_db::insert_asset(
                &project.db,
                &asset_id,
                &original_path,
                &file_name,
                &probe.metadata,
                &probe.raw_json,
            )?;

            let ctx = pipeline::DerivativeContext {
                jobs: &jobs,
                conn: &project.db,
                project_root: &project.root,
                tools: &tools,
            };
            let derivative_asset = pipeline::DerivativeAsset {
                id: &asset_id,
                file_name: &file_name,
                source: &path,
                metadata: &probe.metadata,
            };
            pipeline::enqueue_for_asset(&ctx, &derivative_asset, options)?;

            media_db::get_asset(&project.db, &asset_id)
        })?;

        // The WebView reads the untouched source through the asset protocol until a proxy is ready.
        let _ = app.asset_protocol_scope().allow_file(&path);
        outcome.imported.push(asset);
    }

    Ok(outcome)
}

#[tauri::command]
pub fn list_media(app: AppHandle, state: State<'_, AppState>) -> AppResult<Vec<MediaAsset>> {
    let assets = state.with_project(|project| media_db::list_assets(&project.db))?;

    // Re-granting scope on every listing keeps previews working after reopening a project,
    // because the durable scope lives with the app process, not with the database.
    for asset in &assets {
        let _ = app.asset_protocol_scope().allow_file(&asset.original_path);
    }

    Ok(assets)
}

#[tauri::command]
pub fn get_media(state: State<'_, AppState>, media_id: String) -> AppResult<MediaAsset> {
    state.with_project(|project| media_db::get_asset(&project.db, &media_id))
}

/// Removes an asset from the project. The source file is never deleted (spec §4.2); only the
/// derivatives this project generated are cleaned up.
#[tauri::command]
pub fn remove_media(state: State<'_, AppState>, media_id: String) -> AppResult<()> {
    let running = state.jobs().list().into_iter().any(|job| {
        job.media_asset_id.as_deref() == Some(media_id.as_str()) && !job.status.is_finished()
    });
    if running {
        return Err(AppError::InvalidInput(
            "cancel this asset's running jobs before removing it".into(),
        ));
    }

    state.with_project(|project| {
        let asset = media_db::get_asset(&project.db, &media_id)?;
        for derivative in &asset.derivatives {
            if let Some(relative) = derivative.relative_path.as_deref() {
                if let Ok(path) = project::resolve_relative(&project.root, relative) {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        media_db::delete_asset(&project.db, &media_id)
    })
}

/// Reports, for every derivative kind, whether it applies to this asset.
#[tauri::command]
pub fn plan_media_derivatives(
    state: State<'_, AppState>,
    media_id: String,
) -> AppResult<Vec<DerivativePlanView>> {
    // Derivative tunables live in the application database, never in the project database.
    let options = pipeline::derivative_options(&state.app_db())?;

    state.with_project(|project| {
        let asset = media_db::get_asset(&project.db, &media_id)?;

        Ok(pipeline::GENERATION_ORDER
            .iter()
            .map(
                |kind| match engine::plan(*kind, &asset.metadata(), options) {
                    DerivativePlan::NotApplicable { reason } => DerivativePlanView {
                        kind: *kind,
                        applicable: false,
                        reason: Some(reason.to_string()),
                        params: serde_json::Value::Null,
                    },
                    plan => DerivativePlanView {
                        kind: *kind,
                        applicable: true,
                        reason: None,
                        params: engine::plan_params(&plan),
                    },
                },
            )
            .collect())
    })
}

/// Rebuilds one derivative, replacing whatever is on disk. Used by retry in the jobs panel.
#[tauri::command]
pub fn regenerate_derivative(
    state: State<'_, AppState>,
    media_id: String,
    kind: DerivativeKind,
) -> AppResult<String> {
    let jobs = state.jobs();
    let job_kind = crate::jobs::JobKind::from(kind);
    let already_running = jobs.list().into_iter().any(|job| {
        job.media_asset_id.as_deref() == Some(media_id.as_str())
            && job.kind == job_kind
            && !job.status.is_finished()
    });
    if already_running {
        return Err(AppError::InvalidInput(format!(
            "{kind} is already being generated"
        )));
    }

    let tools = state.ffmpeg()?;
    let options = pipeline::derivative_options(&state.app_db())?;
    state.with_project(|project| {
        let asset = media_db::get_asset(&project.db, &media_id)?;
        let metadata = asset.metadata();
        let ctx = pipeline::DerivativeContext {
            jobs: &jobs,
            conn: &project.db,
            project_root: &project.root,
            tools: &tools,
        };
        let derivative_asset = pipeline::DerivativeAsset {
            id: &media_id,
            file_name: &asset.file_name,
            source: Path::new(&asset.original_path),
            metadata: &metadata,
        };
        pipeline::enqueue_kind(&ctx, &derivative_asset, kind, options)
    })
}

/// Loads the stored waveform envelope for the preview panel.
///
/// The path is resolved under the project lock, but the read itself happens on a blocking thread
/// pool: the envelope is tens of kilobytes and the file can be on a slow drive.
#[tauri::command]
pub async fn read_waveform(
    state: State<'_, AppState>,
    media_id: String,
) -> AppResult<WaveformData> {
    let path = state.with_project(|project| {
        let derivative =
            media_db::get_derivative(&project.db, &media_id, DerivativeKind::Waveform)?
                .filter(|derivative| derivative.status == DerivativeStatus::Ready)
                .ok_or_else(|| {
                    AppError::InvalidInput("the waveform has not been generated yet".into())
                })?;

        let relative = derivative
            .relative_path
            .ok_or_else(|| AppError::Internal("a ready waveform has no stored path".into()))?;
        project::resolve_relative(&project.root, &relative)
    })?;

    let text =
        tauri::async_runtime::spawn_blocking(move || std::fs::read_to_string(path)).await??;
    Ok(serde_json::from_str(&text)?)
}
