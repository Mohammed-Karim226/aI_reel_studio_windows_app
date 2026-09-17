//! Derivative pipeline: turns "this asset needs a proxy" into a tracked, cancellable job.
//!
//! Import only *plans* here; the ffmpeg work happens on a worker thread so the UI stays
//! responsive (spec §28) and every step is observable through the job registry (spec §29).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};

use rusqlite::Connection;
use tracing::{info, warn};

use crate::db;
use crate::db::media as media_db;
use crate::db::settings;
use crate::error::{AppError, AppResult};
use crate::jobs::{JobKind, JobRegistry};
use crate::logging::category;
use crate::media::engine::{self, DerivativeOptions, DerivativePlan, MediaDeriver};
use crate::media::ffmpeg::FfmpegTools;
use crate::media::runner::CancelToken;
use crate::media::types::{DerivativeKind, DerivativeStatus, MediaMetadata};
use crate::project;

/// Order in which a fresh import generates derivatives: the poster frame first so the library
/// fills in immediately, the proxy last because it is the longest run.
pub const GENERATION_ORDER: [DerivativeKind; 4] = [
    DerivativeKind::Thumbnail,
    DerivativeKind::Filmstrip,
    DerivativeKind::Waveform,
    DerivativeKind::Proxy,
];

/// Derivative tunables, currently the proxy height from app settings (spec §34).
///
/// `conn` must be the *application* database: `app_settings` lives there, and the project database
/// has no such table.
pub fn derivative_options(conn: &Connection) -> AppResult<DerivativeOptions> {
    let mut options = DerivativeOptions::default();
    if let Some(value) = settings::get(conn, settings::keys::PROXY_HEIGHT)? {
        if let Ok(height) = value.trim().parse::<u32>() {
            options.proxy_height = height.max(2);
        }
    }
    Ok(options)
}

/// How many ffmpeg processes may run at once. Decoding several long videos concurrently makes the
/// machine unusable, so extra work waits and stays "queued" in the panel until a slot frees up.
const MAX_CONCURRENT_DERIVATIVES: usize = 2;

static SLOTS: OnceLock<SlotPool> = OnceLock::new();

fn slots() -> &'static SlotPool {
    SLOTS.get_or_init(|| SlotPool::new(MAX_CONCURRENT_DERIVATIVES))
}

/// A counting semaphore. `std` has none, and a dependency is not worth two fields and a condvar.
struct SlotPool {
    available: Mutex<usize>,
    ready: Condvar,
}

impl SlotPool {
    fn new(permits: usize) -> Self {
        Self {
            available: Mutex::new(permits.max(1)),
            ready: Condvar::new(),
        }
    }

    fn acquire(&self) -> SlotGuard<'_> {
        let mut available = lock(&self.available);
        while *available == 0 {
            available = self
                .ready
                .wait(available)
                .unwrap_or_else(|poisoned| poisoned.into_inner());
        }
        *available -= 1;
        SlotGuard { pool: self }
    }
}

struct SlotGuard<'a> {
    pool: &'a SlotPool,
}

impl Drop for SlotGuard<'_> {
    fn drop(&mut self) {
        let mut available = lock(&self.pool.available);
        *available += 1;
        self.pool.ready.notify_one();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Everything a worker needs, owned so it can move onto a thread.
struct DerivativeTask {
    jobs: Arc<JobRegistry>,
    job_id: String,
    asset_id: String,
    kind: DerivativeKind,
    database_path: PathBuf,
    tools: FfmpegTools,
    metadata: MediaMetadata,
    options: DerivativeOptions,
    source: PathBuf,
    output: PathBuf,
    /// Rendered first, then moved over `output` only on success.
    staging: PathBuf,
    relative_path: String,
    params: serde_json::Value,
    cancel: CancelToken,
    /// A ready artifact already exists; a failed or cancelled rerun must not destroy it.
    replaces_ready_artifact: bool,
}

enum TaskOutcome {
    Completed(Option<String>),
    /// Planned as applicable, but the asset turned out not to support it.
    Skipped(String),
}

/// The derivatives that genuinely apply to an asset, with their plans, in generation order.
///
/// Pure so the "what will be generated?" rule is testable without a media file or a worker.
pub fn applicable_plans(
    metadata: &MediaMetadata,
    options: DerivativeOptions,
) -> Vec<(DerivativeKind, DerivativePlan)> {
    GENERATION_ORDER
        .iter()
        .filter_map(|kind| match engine::plan(*kind, metadata, options) {
            DerivativePlan::NotApplicable { .. } => None,
            plan => Some((*kind, plan)),
        })
        .collect()
}

/// Ambient context every derivative job needs: the registry it reports to, the project database
/// it records into, the project root it writes into, and the resolved toolchain.
pub struct DerivativeContext<'a> {
    pub jobs: &'a Arc<JobRegistry>,
    pub conn: &'a Connection,
    pub project_root: &'a Path,
    pub tools: &'a FfmpegTools,
}

/// The asset a derivative is generated for.
pub struct DerivativeAsset<'a> {
    pub id: &'a str,
    pub file_name: &'a str,
    /// Untouched source file (spec §4.2).
    pub source: &'a Path,
    pub metadata: &'a MediaMetadata,
}

/// Queues every derivative that applies to this asset. Returns the created job ids.
///
/// `options` comes from [`derivative_options`] with the *application* connection.
pub fn enqueue_for_asset(
    ctx: &DerivativeContext<'_>,
    asset: &DerivativeAsset<'_>,
    options: DerivativeOptions,
) -> AppResult<Vec<String>> {
    validate_source(asset.source)?;

    let mut tasks = Vec::new();
    for (kind, plan) in applicable_plans(asset.metadata, options) {
        tasks.push(queue(ctx, asset, kind, options, plan)?);
    }

    let job_ids = tasks.iter().map(|task| task.job_id.clone()).collect();
    spawn_runner(tasks);
    Ok(job_ids)
}

/// Queues one derivative kind, replacing any previous artifact. Fails when the derivative makes
/// no sense for this asset, so the UI can explain why instead of showing a doomed job.
pub fn enqueue_kind(
    ctx: &DerivativeContext<'_>,
    asset: &DerivativeAsset<'_>,
    kind: DerivativeKind,
    options: DerivativeOptions,
) -> AppResult<String> {
    validate_source(asset.source)?;

    let plan = match engine::plan(kind, asset.metadata, options) {
        DerivativePlan::NotApplicable { reason } => {
            return Err(AppError::InvalidInput(format!(
                "{kind} cannot be generated: {reason}"
            )))
        }
        plan => plan,
    };

    let task = queue(ctx, asset, kind, options, plan)?;
    let job_id = task.job_id.clone();
    spawn_runner(vec![task]);
    Ok(job_id)
}

/// FFmpeg reads its input as a URL, so a scheme (`http:`, `concat:`, `subfile:`) or a UNC share
/// must never reach it as a "file path" from a project database that is portable and hand-editable.
fn validate_source(source: &Path) -> AppResult<()> {
    if !is_local_path(source) {
        return Err(AppError::UnsupportedMedia(format!(
            "{} is not a local file path",
            source.display()
        )));
    }
    if !source.is_file() {
        return Err(AppError::MediaFileNotFound(source.to_path_buf()));
    }
    Ok(())
}

fn is_local_path(path: &Path) -> bool {
    let raw = path.to_string_lossy().into_owned();

    // Verbatim paths (`\\?\`) are local, but they can still wrap a UNC share (`\\?\UNC\...`).
    let text = match raw.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_string(),
        None if raw.starts_with(r"\\") => return false,
        None => raw,
    };

    if text.to_ascii_uppercase().starts_with("UNC\\") {
        return false;
    }

    match text.find(':') {
        // `C:` is a drive letter; any other colon marks a URI scheme.
        Some(index) => index == 1 && text.as_bytes()[0].is_ascii_alphabetic(),
        None => true,
    }
}

fn queue(
    ctx: &DerivativeContext<'_>,
    asset: &DerivativeAsset<'_>,
    kind: DerivativeKind,
    options: DerivativeOptions,
    plan: DerivativePlan,
) -> AppResult<DerivativeTask> {
    let name = asset.file_name;
    let label = format!("{} · {name}", title(kind));
    let job_id = ctx
        .jobs
        .create(JobKind::from(kind), label, Some(asset.id.to_string()));
    let relative_path = project::derivative_relative_path(asset.id, kind);
    let params = engine::plan_params(&plan);

    // A ready artifact keeps its row until the new run succeeds, so a failed rerun cannot erase
    // the path to the file that is still on disk. Only genuinely new work is recorded as pending.
    let existing = media_db::get_derivative(ctx.conn, asset.id, kind)?;
    let replaces_ready_artifact = existing.as_ref().is_some_and(|derivative| {
        derivative.status == DerivativeStatus::Ready && derivative.relative_path.is_some()
    });

    if !replaces_ready_artifact {
        media_db::upsert_derivative(
            ctx.conn,
            &job_id,
            asset.id,
            kind,
            DerivativeStatus::Pending,
            None,
            &params,
            None,
        )?;
    }

    let cancel = ctx
        .jobs
        .cancel_token(&job_id)
        .ok_or_else(|| AppError::Internal("job disappeared before it started".into()))?;

    let output = project::resolve_relative(ctx.project_root, &relative_path)?;
    let staging = project::staging_path(&output);

    Ok(DerivativeTask {
        jobs: Arc::clone(ctx.jobs),
        job_id,
        asset_id: asset.id.to_string(),
        kind,
        database_path: project::database_path(ctx.project_root),
        tools: ctx.tools.clone(),
        metadata: asset.metadata.clone(),
        options,
        source: asset.source.to_path_buf(),
        output,
        staging,
        relative_path,
        params,
        cancel,
        replaces_ready_artifact,
    })
}

/// Runs queued tasks one after another on a single worker.
///
/// One thread per asset rather than per derivative keeps the thread count proportional to the
/// import, and the slot pool caps how many ffmpeg processes actually run at once.
fn spawn_runner(tasks: Vec<DerivativeTask>) {
    if tasks.is_empty() {
        return;
    }

    std::thread::spawn(move || {
        for task in tasks {
            run_one(&task);
        }
    });
}

fn run_one(task: &DerivativeTask) {
    if task.cancel.is_cancelled() {
        task.jobs.mark_cancelled(&task.job_id);
        return;
    }

    // Wait for a slot before claiming to be running, so the panel shows honest queuing.
    let _slot = slots().acquire();

    if task.cancel.is_cancelled() {
        task.jobs.mark_cancelled(&task.job_id);
        return;
    }

    // A panicking worker must surface as a failed job, not a job stuck on "running".
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| run(task)))
        .unwrap_or_else(|_| Err(AppError::Internal("derivative worker panicked".into())));

    match outcome {
        Ok(TaskOutcome::Completed(message)) => task.jobs.mark_completed(&task.job_id, message),
        Ok(TaskOutcome::Skipped(reason)) => task.jobs.mark_skipped(&task.job_id, &reason),
        Err(AppError::JobCancelled) => task.jobs.mark_cancelled(&task.job_id),
        Err(error) => task.jobs.mark_failed(&task.job_id, &error),
    }
}

fn run(task: &DerivativeTask) -> AppResult<TaskOutcome> {
    task.jobs.mark_running(&task.job_id);
    info!(
        target: category::MEDIA,
        job = %task.job_id,
        asset = %task.asset_id,
        kind = %task.kind,
        "derivative started"
    );

    // Workers own their connection: the UI thread holds the project connection, and SQLite in WAL
    // mode lets both proceed without blocking each other.
    let conn = db::open_project_db(&task.database_path)?;

    // Clean up after an earlier crash before reusing the staging path.
    remove_file_if_present(&task.staging);

    let mut on_progress = |fraction: f64| task.jobs.report_progress(&task.job_id, fraction);
    let engine = engine::FfmpegEngine::new(task.tools.clone());
    let request = engine::DerivativeRequest {
        kind: task.kind,
        source: &task.source,
        output: &task.staging,
        metadata: &task.metadata,
        options: task.options,
    };
    let result = engine.derive(&request, &task.cancel, &mut on_progress);

    match result {
        Ok(output) if output.produced => {
            publish(task, &conn, &output.params)?;
            info!(
                target: category::MEDIA,
                job = %task.job_id,
                path = %task.relative_path,
                "derivative ready"
            );
            Ok(TaskOutcome::Completed(Some(task.relative_path.clone())))
        }

        Ok(output) => {
            let reason = output
                .params
                .get("notApplicable")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("derivative does not apply to this asset")
                .to_string();
            remove_file_if_present(&task.staging);
            if !task.replaces_ready_artifact {
                media_db::upsert_derivative(
                    &conn,
                    &task.job_id,
                    &task.asset_id,
                    task.kind,
                    DerivativeStatus::Failed,
                    None,
                    &output.params,
                    Some(&reason),
                )?;
            }
            Ok(TaskOutcome::Skipped(reason))
        }

        Err(AppError::JobCancelled) => {
            remove_file_if_present(&task.staging);
            if !task.replaces_ready_artifact {
                media_db::delete_derivative(&conn, &task.asset_id, task.kind)?;
            }
            Err(AppError::JobCancelled)
        }

        Err(error) => {
            remove_file_if_present(&task.staging);
            if !task.replaces_ready_artifact {
                media_db::upsert_derivative(
                    &conn,
                    &task.job_id,
                    &task.asset_id,
                    task.kind,
                    DerivativeStatus::Failed,
                    None,
                    &task.params,
                    Some(&error.to_string()),
                )?;
            }
            Err(error)
        }
    }
}

/// Moves a finished artifact into place and records it.
///
/// The previous file is removed only once the replacement is complete, so an interrupted run
/// never leaves the asset with no artifact at all.
fn publish(task: &DerivativeTask, conn: &Connection, params: &serde_json::Value) -> AppResult<()> {
    if task.output.exists() {
        std::fs::remove_file(&task.output)?;
    }
    std::fs::rename(&task.staging, &task.output)?;

    media_db::upsert_derivative(
        conn,
        &task.job_id,
        &task.asset_id,
        task.kind,
        DerivativeStatus::Ready,
        Some(&task.relative_path),
        params,
        None,
    )
}

/// A cancelled or crashed run can leave a truncated staging file behind.
fn remove_file_if_present(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            warn!(
                target: category::MEDIA,
                path = %path.display(),
                "could not remove a partial derivative: {error}"
            );
        }
    }
}

fn title(kind: DerivativeKind) -> &'static str {
    match kind {
        DerivativeKind::Thumbnail => "Thumbnail",
        DerivativeKind::Filmstrip => "Filmstrip",
        DerivativeKind::Waveform => "Waveform",
        DerivativeKind::Proxy => "Proxy",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_app_db_in_memory;
    use crate::media::types::{AudioStreamInfo, MediaKind, VideoStreamInfo};

    fn metadata() -> MediaMetadata {
        MediaMetadata {
            kind: MediaKind::Video,
            container: Some("mov,mp4".into()),
            duration_sec: 3600.0,
            size_bytes: 4_000_000_000,
            video: Some(VideoStreamInfo {
                codec: "h264".into(),
                width: 3840,
                height: 2160,
                display_width: 3840,
                display_height: 2160,
                fps: 29.97,
                rotation: 0,
                pix_fmt: Some("yuv420p".into()),
                bit_rate: Some(45_000_000),
            }),
            audio: Some(AudioStreamInfo {
                codec: "aac".into(),
                channels: 2,
                sample_rate: 48_000,
                bit_rate: Some(192_000),
            }),
        }
    }

    fn silent_video() -> MediaMetadata {
        MediaMetadata {
            audio: None,
            ..metadata()
        }
    }

    #[test]
    fn settings_override_the_proxy_height() {
        let conn = open_app_db_in_memory().expect("app db");
        assert_eq!(
            derivative_options(&conn).expect("defaults").proxy_height,
            720
        );

        settings::set(&conn, settings::keys::PROXY_HEIGHT, "540").expect("set");
        assert_eq!(
            derivative_options(&conn).expect("configured").proxy_height,
            540
        );
    }

    #[test]
    fn an_unparseable_setting_falls_back_to_the_default() {
        let conn = open_app_db_in_memory().expect("app db");
        settings::set(&conn, settings::keys::PROXY_HEIGHT, "not-a-number").expect("set");
        assert_eq!(
            derivative_options(&conn).expect("defaults").proxy_height,
            720
        );
    }

    #[test]
    fn a_degenerate_proxy_height_is_corrected() {
        let conn = open_app_db_in_memory().expect("app db");
        settings::set(&conn, settings::keys::PROXY_HEIGHT, "0").expect("set");
        assert_eq!(derivative_options(&conn).expect("options").proxy_height, 2);
    }

    #[test]
    fn a_silent_video_queues_no_waveform_job() {
        let options = DerivativeOptions::default();
        let kinds: Vec<DerivativeKind> = applicable_plans(&silent_video(), options)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();

        assert!(
            !kinds.contains(&DerivativeKind::Waveform),
            "a silent asset cannot carry a waveform"
        );
        assert_eq!(kinds.first(), Some(&DerivativeKind::Thumbnail));
    }

    #[test]
    fn an_audio_only_asset_queues_only_the_waveform() {
        let options = DerivativeOptions::default();
        let metadata = MediaMetadata {
            kind: MediaKind::Audio,
            video: None,
            ..metadata()
        };

        let kinds: Vec<DerivativeKind> = applicable_plans(&metadata, options)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();
        assert_eq!(kinds, vec![DerivativeKind::Waveform]);
    }

    #[test]
    fn a_large_video_queues_all_four_derivatives_in_generation_order() {
        let options = DerivativeOptions::default();
        let kinds: Vec<DerivativeKind> = applicable_plans(&metadata(), options)
            .into_iter()
            .map(|(kind, _)| kind)
            .collect();

        assert_eq!(kinds, GENERATION_ORDER.to_vec());
    }

    #[test]
    fn every_queued_plan_carries_parameters_for_the_pending_row() {
        let options = DerivativeOptions::default();
        for (kind, plan) in applicable_plans(&metadata(), options) {
            let params = engine::plan_params(&plan);
            assert!(
                params.get("notApplicable").is_none(),
                "{kind} was queued, so it must not describe itself as not applicable"
            );
        }
    }

    #[test]
    fn local_source_paths_are_accepted() {
        assert!(is_local_path(Path::new(r"D:\media\podcast.mp4")));
        assert!(is_local_path(Path::new("relative/clip.mov")));
        assert!(is_local_path(Path::new(r"\\?\D:\media\podcast.mp4")));
    }

    #[test]
    fn url_schemes_and_unc_shares_are_rejected_before_ffmpeg_sees_them() {
        // FFmpeg treats its input as a URL, so these would become network or device reads.
        assert!(!is_local_path(Path::new("http://example.com/clip.mp4")));
        assert!(!is_local_path(Path::new("https://example.com/clip.mp4")));
        assert!(!is_local_path(Path::new("concat:a.mp4|b.mp4")));
        assert!(!is_local_path(Path::new("subfile:clip.mp4")));
        assert!(!is_local_path(Path::new("pipe:0")));
        assert!(!is_local_path(Path::new(r"\\server\share\clip.mp4")));
        assert!(!is_local_path(Path::new(r"\\?\UNC\server\share\clip.mp4")));
    }

    #[test]
    fn a_missing_source_fails_the_queue_step_instead_of_the_worker() {
        let error = validate_source(Path::new(r"D:\media\definitely-missing.mp4"))
            .expect_err("missing file");
        assert_eq!(error.kind(), "media_file_not_found");
    }

    #[test]
    fn a_waiting_worker_gets_the_slot_when_it_is_released() {
        let pool = Arc::new(SlotPool::new(1));
        let held = pool.acquire();

        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let waiter = {
            let pool = Arc::clone(&pool);
            std::thread::spawn(move || {
                started_tx.send(()).expect("signal");
                let _slot = pool.acquire();
            })
        };

        started_rx.recv().expect("waiter started");
        // Give the waiter time to block on the condvar; with a broken pool it finishes instantly.
        std::thread::sleep(std::time::Duration::from_millis(30));
        assert!(
            !waiter.is_finished(),
            "the second worker must wait until a slot is free"
        );

        drop(held);
        waiter.join().expect("waiter finishes once a slot frees");
    }
}
