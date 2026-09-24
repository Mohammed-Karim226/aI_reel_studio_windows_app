use tauri::{AppHandle, Manager, State};

use crate::error::{AppError, AppResult};
use crate::jobs::JobKind;
use crate::state::AppState;
use crate::timeline::invalid;
use crate::transcription::setup::{self, TranscriptionReadiness, TranscriptionSetup};
use crate::transcription::{self, FasterWhisper, MediaTranscription, Transcript};

/// Opens packaged instructions. Installing/downloading remains an explicit user action.
#[tauri::command]
pub fn open_transcription_setup_folder(app: AppHandle) -> AppResult<()> {
    let folder = app.path().resource_dir()?.join("speech-setup");
    #[cfg(debug_assertions)]
    let folder = if folder.is_dir() {
        folder
    } else {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts")
    };
    if !folder.join("setup-transcription.ps1").is_file() {
        return Err(invalid(
            "The speech setup helper is missing. Reinstall AI Reel Studio to restore it.",
        ));
    }
    #[cfg(windows)]
    {
        crate::media::runner::command(std::path::Path::new("explorer.exe"))
            .arg(folder)
            .spawn()?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err(invalid("Opening the setup folder requires Windows"))
}

#[tauri::command]
pub fn get_transcription_setup(
    state: State<'_, AppState>,
) -> AppResult<Option<TranscriptionSetup>> {
    setup::get(&state.app_db())
}

#[tauri::command]
pub fn save_transcription_setup(
    state: State<'_, AppState>,
    setup: TranscriptionSetup,
) -> AppResult<TranscriptionSetup> {
    setup::save(&state.app_db(), setup)
}

/// Native dependency/model inspection runs away from the WebView message thread.
#[tauri::command]
pub async fn check_transcription_setup(
    app: AppHandle,
    setup: TranscriptionSetup,
) -> AppResult<TranscriptionReadiness> {
    let setup = setup.normalize()?;
    let slot = transcription::queue::try_acquire_for_check();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let ffmpeg_issue = state
            .ffmpeg()
            .err()
            .map(|error| format!("Set up FFmpeg and FFprobe before transcribing: {error}"));
        let mut status = TranscriptionReadiness::new(ffmpeg_issue);
        match slot {
            Ok(_slot) => setup::check(&setup, status),
            Err(error) => {
                status.issues.push(error.to_string());
                status
            }
        }
    })
    .await
    .map_err(AppError::from)
}

/// Source paths are resolved only through the active project's media library.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn transcribe_media(
    state: State<'_, AppState>,
    project_id: String,
    media_id: String,
    source_start: f64,
    source_end: f64,
    python_path: String,
    model_path: String,
    language: String,
) -> AppResult<Transcript> {
    let (root, asset) = state.with_project(|project| {
        if project.summary.id != project_id {
            return Err(invalid("the active project changed"));
        }
        let asset = crate::db::media::get_asset(&project.db, &media_id)?;
        transcription::validate_range(source_start, source_end, asset.duration_sec, &language)?;
        if !asset.has_audio {
            return Err(invalid("selected media has no audio stream"));
        }
        Ok((project.root.clone(), asset))
    })?;
    let provider = FasterWhisper::new(&python_path, &model_path)?;
    let tools = state.ffmpeg()?;
    let jobs = state.jobs();
    let job_id = jobs.create(
        JobKind::Transcription,
        format!("Transcribe · {}", asset.file_name),
        Some(media_id.clone()),
    );
    let cancel = jobs
        .cancel_token(&job_id)
        .ok_or_else(|| AppError::JobNotFound(job_id.clone()))?;
    let worker_jobs = jobs.clone();
    let worker_id = job_id.clone();
    let result = async {
        let slot = transcription::queue::acquire(&cancel).await?;
        state.with_project(|project| {
            if project.summary.id != project_id {
                return Err(invalid(
                    "the active project changed while transcription was queued",
                ));
            }
            crate::db::media::get_asset(&project.db, &media_id)?;
            Ok(())
        })?;
        tauri::async_runtime::spawn_blocking(move || {
            let _slot = slot;
            if cancel.is_cancelled() {
                return Err(AppError::JobCancelled);
            }
            worker_jobs.mark_running(&worker_id);
            transcription::transcribe_media(
                &MediaTranscription {
                    root: &root,
                    asset: &asset,
                    source_start,
                    source_end,
                    language: &language,
                },
                &tools,
                &provider,
                &cancel,
                &mut |fraction| worker_jobs.report_progress(&worker_id, fraction),
            )
        })
        .await
        .map_err(AppError::from)
        .and_then(|result| result)
    }
    .await;
    // A result from a closed/switched project must never be applied to another project.
    let result = result.and_then(|transcript| {
        state.with_project(|project| {
            if project.summary.id != project_id {
                return Err(invalid(
                    "the active project changed; transcript was not applied",
                ));
            }
            crate::db::media::get_asset(&project.db, &media_id)?;
            Ok(transcript)
        })
    });
    match &result {
        Ok(transcript) => jobs.mark_completed(
            &job_id,
            Some(format!("{} words transcribed", transcript.words.len())),
        ),
        Err(AppError::JobCancelled) => jobs.mark_cancelled(&job_id),
        Err(error) => jobs.mark_failed(&job_id, error),
    }
    result
}
