//! Background job tracking.
//!
//! Every long media operation runs on a worker thread and reports through this registry, which is
//! the single source of truth for the jobs panel. The registry knows nothing about Tauri: it
//! pushes snapshots to a [`JobEmitter`], which the app layer implements with an `AppHandle`.

pub mod pipeline;

use std::collections::HashMap;
use std::fmt;
use std::sync::Mutex;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::error::{AppError, AppResult, ErrorEnvelope};
use crate::logging::category;
use crate::media::runner::CancelToken;
use crate::media::types::DerivativeKind;

/// Event name the frontend listens on for live job updates.
pub const JOB_EVENT: &str = "job://update";

/// Failed jobs carry the same envelope as failed commands, so the frontend has one error shape.
pub type JobError = ErrorEnvelope;

/// How many finished jobs to keep for the panel before dropping the oldest.
const FINISHED_HISTORY_LIMIT: usize = 100;

/// Minimum progress change worth telling the UI about. Without this, a fast transcode emits
/// thousands of events a second and starves the WebView.
const PROGRESS_EPSILON: f64 = 0.01;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Thumbnail,
    Filmstrip,
    Waveform,
    Proxy,
    Transcription,
}

impl JobKind {
    pub fn as_str(self) -> &'static str {
        match self {
            JobKind::Thumbnail => "thumbnail",
            JobKind::Filmstrip => "filmstrip",
            JobKind::Waveform => "waveform",
            JobKind::Proxy => "proxy",
            JobKind::Transcription => "transcription",
        }
    }
}

impl fmt::Display for JobKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl From<DerivativeKind> for JobKind {
    fn from(kind: DerivativeKind) -> Self {
        match kind {
            DerivativeKind::Thumbnail => JobKind::Thumbnail,
            DerivativeKind::Filmstrip => JobKind::Filmstrip,
            DerivativeKind::Waveform => JobKind::Waveform,
            DerivativeKind::Proxy => JobKind::Proxy,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running,
    Completed,
    /// The work did not apply to this asset — a silent clip has no waveform. Distinct from
    /// `Failed` so the UI never shows an error for something that was never possible.
    Skipped,
    Failed,
    Cancelled,
}

impl JobStatus {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            JobStatus::Completed | JobStatus::Skipped | JobStatus::Failed | JobStatus::Cancelled
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobSnapshot {
    pub id: String,
    pub kind: JobKind,
    pub status: JobStatus,
    /// Human-readable description, e.g. "Proxy · podcast.mp4".
    pub label: String,
    /// `0.0..=1.0`, or `None` while the duration is unknown so the UI can show an indeterminate
    /// bar instead of a bar stuck at zero.
    pub progress: Option<f64>,
    pub message: Option<String>,
    pub error: Option<JobError>,
    pub media_asset_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl JobSnapshot {
    pub fn is_cancellable(&self) -> bool {
        matches!(self.status, JobStatus::Queued | JobStatus::Running)
    }
}

/// Receives every snapshot change. Implemented by the app layer to forward to the WebView.
pub trait JobEmitter: Send + Sync {
    fn emit(&self, snapshot: &JobSnapshot);
}

/// Discards events. Used in tests and before a window exists.
#[derive(Debug, Default)]
pub struct NoopEmitter;

impl JobEmitter for NoopEmitter {
    fn emit(&self, _snapshot: &JobSnapshot) {}
}

struct JobRecord {
    snapshot: JobSnapshot,
    cancel: CancelToken,
    last_emitted_progress: f64,
}

#[derive(Default)]
struct JobStore {
    /// Creation order, so the panel lists newest first without sorting timestamps.
    order: Vec<String>,
    records: HashMap<String, JobRecord>,
}

pub struct JobRegistry {
    store: Mutex<JobStore>,
    emitter: Box<dyn JobEmitter>,
}

impl JobRegistry {
    pub fn new(emitter: Box<dyn JobEmitter>) -> Self {
        Self {
            store: Mutex::new(JobStore::default()),
            emitter,
        }
    }

    /// A registry that tracks jobs without notifying anyone.
    pub fn silent() -> Self {
        Self::new(Box::new(NoopEmitter))
    }

    /// Registers a queued job and returns its id.
    pub fn create(&self, kind: JobKind, label: String, media_asset_id: Option<String>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let snapshot = JobSnapshot {
            id: id.clone(),
            kind,
            status: JobStatus::Queued,
            label,
            progress: None,
            message: None,
            error: None,
            media_asset_id,
            created_at: now.clone(),
            updated_at: now,
        };

        let emitted = {
            let mut store = self.lock();
            store.order.push(id.clone());
            store.records.insert(
                id.clone(),
                JobRecord {
                    snapshot: snapshot.clone(),
                    cancel: CancelToken::new(),
                    last_emitted_progress: -1.0,
                },
            );
            prune(&mut store);
            snapshot
        };

        self.emitter.emit(&emitted);
        id
    }

    pub fn cancel_token(&self, id: &str) -> Option<CancelToken> {
        self.lock()
            .records
            .get(id)
            .map(|record| record.cancel.clone())
    }

    /// Requests cancellation. The worker observes the token and stops at its next checkpoint, so
    /// the status only becomes `Cancelled` once the worker actually unwinds.
    pub fn request_cancel(&self, id: &str) -> AppResult<()> {
        let token = {
            let store = self.lock();
            let record = store
                .records
                .get(id)
                .ok_or_else(|| AppError::JobNotFound(id.to_string()))?;
            if !record.snapshot.is_cancellable() {
                return Err(AppError::InvalidInput(format!(
                    "job {id} has already finished"
                )));
            }
            record.cancel.clone()
        };

        token.cancel();
        info!(target: category::SYSTEM, job = %id, "cancellation requested");
        Ok(())
    }

    pub fn mark_running(&self, id: &str) {
        self.update(id, |record| {
            record.snapshot.status = JobStatus::Running;
            record.snapshot.progress = Some(0.0);
        });
    }

    /// Reports progress, throttled so only meaningful changes reach the UI.
    pub fn report_progress(&self, id: &str, fraction: f64) {
        let fraction = fraction.clamp(0.0, 1.0);
        let emitted = {
            let mut store = self.lock();
            let Some(record) = store.records.get_mut(id) else {
                return;
            };
            let worth_emitting = fraction >= 1.0
                || record.last_emitted_progress < 0.0
                || (fraction - record.last_emitted_progress).abs() >= PROGRESS_EPSILON;

            record.snapshot.progress = Some(fraction);
            record.snapshot.updated_at = Utc::now().to_rfc3339();
            if !worth_emitting {
                return;
            }
            record.last_emitted_progress = fraction;
            record.snapshot.clone()
        };

        self.emitter.emit(&emitted);
    }

    pub fn mark_completed(&self, id: &str, message: Option<String>) {
        self.update(id, |record| {
            record.snapshot.status = JobStatus::Completed;
            record.snapshot.progress = Some(1.0);
            record.snapshot.message = message.clone();
            record.snapshot.error = None;
        });
    }

    /// The work did not apply. `reason` explains why, verbatim, to the user.
    pub fn mark_skipped(&self, id: &str, reason: &str) {
        let reason = reason.to_string();
        self.update(id, |record| {
            record.snapshot.status = JobStatus::Skipped;
            record.snapshot.progress = Some(1.0);
            record.snapshot.message = Some(reason.clone());
            record.snapshot.error = None;
        });
    }

    pub fn mark_failed(&self, id: &str, error: &AppError) {
        let envelope = JobError::from(error);
        warn!(
            target: category::SYSTEM,
            job = %id,
            kind = %envelope.kind,
            "job failed: {}",
            envelope.message
        );
        self.update(id, |record| {
            record.snapshot.status = JobStatus::Failed;
            record.snapshot.error = Some(envelope.clone());
        });
    }

    pub fn mark_cancelled(&self, id: &str) {
        self.update(id, |record| {
            record.snapshot.status = JobStatus::Cancelled;
            record.snapshot.message = Some("Cancelled".to_string());
            record.snapshot.error = None;
        });
    }

    /// Records a terminal state from a worker's `Result`, mapping cancellation to its own status
    /// rather than reporting it as a failure.
    pub fn finish(&self, id: &str, outcome: AppResult<Option<String>>) {
        match outcome {
            Ok(message) => self.mark_completed(id, message),
            Err(AppError::JobCancelled) => self.mark_cancelled(id),
            Err(error) => self.mark_failed(id, &error),
        }
    }

    pub fn snapshot(&self, id: &str) -> Option<JobSnapshot> {
        self.lock()
            .records
            .get(id)
            .map(|record| record.snapshot.clone())
    }

    /// All tracked jobs, newest first.
    pub fn list(&self) -> Vec<JobSnapshot> {
        let store = self.lock();
        store
            .order
            .iter()
            .rev()
            .filter_map(|id| store.records.get(id))
            .map(|record| record.snapshot.clone())
            .collect()
    }

    /// Clears finished jobs from the panel. Running jobs are left alone.
    pub fn clear_finished(&self) -> usize {
        let mut store = self.lock();
        let finished: Vec<String> = store
            .records
            .iter()
            .filter(|(_, record)| record.snapshot.status.is_finished())
            .map(|(id, _)| id.clone())
            .collect();

        for id in &finished {
            store.records.remove(id);
        }
        let mut order = std::mem::take(&mut store.order);
        order.retain(|id| store.records.contains_key(id));
        store.order = order;
        finished.len()
    }

    fn update<F>(&self, id: &str, mutate: F)
    where
        F: FnOnce(&mut JobRecord),
    {
        let emitted = {
            let mut store = self.lock();
            let Some(record) = store.records.get_mut(id) else {
                return;
            };
            mutate(record);
            record.snapshot.updated_at = Utc::now().to_rfc3339();
            record.snapshot.clone()
        };

        // Emitted outside the lock: an emitter that calls back into the registry would deadlock.
        self.emitter.emit(&emitted);
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, JobStore> {
        // A panicking worker must not permanently poison the jobs panel.
        self.store.lock().unwrap_or_else(|poisoned| {
            warn!(target: category::SYSTEM, "job registry mutex was poisoned; recovering");
            poisoned.into_inner()
        })
    }
}

impl fmt::Debug for JobRegistry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JobRegistry")
            .field("jobs", &self.lock().order.len())
            .finish()
    }
}

/// Drops the oldest finished jobs once the history grows past its limit.
fn prune(store: &mut JobStore) {
    let finished: Vec<String> = store
        .order
        .iter()
        .filter(|id| {
            store
                .records
                .get(*id)
                .is_some_and(|record| record.snapshot.status.is_finished())
        })
        .cloned()
        .collect();

    if finished.len() <= FINISHED_HISTORY_LIMIT {
        return;
    }

    for id in finished
        .iter()
        .take(finished.len() - FINISHED_HISTORY_LIMIT)
    {
        store.records.remove(id);
    }
    let mut order = std::mem::take(&mut store.order);
    order.retain(|id| store.records.contains_key(id));
    store.order = order;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<JobSnapshot>>,
    }

    impl Recorder {
        fn snapshots(&self) -> Vec<JobSnapshot> {
            self.events.lock().expect("recorder lock").clone()
        }
    }

    impl JobEmitter for std::sync::Arc<Recorder> {
        fn emit(&self, snapshot: &JobSnapshot) {
            self.events
                .lock()
                .expect("recorder lock")
                .push(snapshot.clone());
        }
    }

    fn registry_with_recorder() -> (JobRegistry, std::sync::Arc<Recorder>) {
        let recorder = std::sync::Arc::new(Recorder::default());
        let registry = JobRegistry::new(Box::new(recorder.clone()));
        (registry, recorder)
    }

    fn create(registry: &JobRegistry) -> String {
        registry.create(JobKind::Proxy, "Proxy · a.mp4".into(), Some("m1".into()))
    }

    #[test]
    fn a_new_job_starts_queued_with_indeterminate_progress() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        let snapshot = registry.snapshot(&id).expect("snapshot");

        assert_eq!(snapshot.status, JobStatus::Queued);
        assert_eq!(snapshot.progress, None);
        assert_eq!(snapshot.media_asset_id.as_deref(), Some("m1"));
        assert!(snapshot.is_cancellable());
    }

    #[test]
    fn creating_a_job_notifies_the_emitter() {
        let (registry, recorder) = registry_with_recorder();
        create(&registry);
        assert_eq!(recorder.snapshots().len(), 1);
    }

    #[test]
    fn the_lifecycle_reaches_completed() {
        let registry = JobRegistry::silent();
        let id = create(&registry);

        registry.mark_running(&id);
        assert_eq!(
            registry.snapshot(&id).expect("snapshot").status,
            JobStatus::Running
        );

        registry.report_progress(&id, 0.5);
        assert_eq!(
            registry.snapshot(&id).expect("snapshot").progress,
            Some(0.5)
        );

        registry.mark_completed(&id, Some("proxies/m1.mp4".into()));
        let snapshot = registry.snapshot(&id).expect("snapshot");
        assert_eq!(snapshot.status, JobStatus::Completed);
        assert_eq!(snapshot.progress, Some(1.0));
        assert!(!snapshot.is_cancellable());
    }

    #[test]
    fn progress_events_are_throttled_but_completion_always_lands() {
        let (registry, recorder) = registry_with_recorder();
        let id = create(&registry);
        recorder.events.lock().expect("lock").clear();

        // 100 tiny increments, well under the epsilon, then the final value.
        for step in 0..100 {
            registry.report_progress(&id, 0.500 + f64::from(step) * 0.0001);
        }
        registry.report_progress(&id, 1.0);

        let emitted = recorder.snapshots();
        assert!(
            emitted.len() < 10,
            "expected throttling, saw {} events",
            emitted.len()
        );
        assert_eq!(
            emitted.last().expect("last event").progress,
            Some(1.0),
            "the final progress value must never be dropped"
        );
    }

    #[test]
    fn a_large_progress_jump_is_always_emitted() {
        let (registry, recorder) = registry_with_recorder();
        let id = create(&registry);
        recorder.events.lock().expect("lock").clear();

        registry.report_progress(&id, 0.25);
        registry.report_progress(&id, 0.75);
        assert_eq!(recorder.snapshots().len(), 2);
    }

    #[test]
    fn progress_is_clamped_to_the_unit_range() {
        let registry = JobRegistry::silent();
        let id = create(&registry);

        registry.report_progress(&id, -1.0);
        assert_eq!(
            registry.snapshot(&id).expect("snapshot").progress,
            Some(0.0)
        );

        registry.report_progress(&id, 4.2);
        assert_eq!(
            registry.snapshot(&id).expect("snapshot").progress,
            Some(1.0)
        );
    }

    #[test]
    fn cancellation_flips_the_workers_token() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        let token = registry.cancel_token(&id).expect("token");

        assert!(!token.is_cancelled());
        registry.request_cancel(&id).expect("cancel");
        assert!(token.is_cancelled());
    }

    #[test]
    fn a_finished_job_cannot_be_cancelled() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        registry.mark_completed(&id, None);

        let error = registry.request_cancel(&id).expect_err("already finished");
        assert_eq!(error.kind(), "invalid_input");
    }

    #[test]
    fn cancelling_an_unknown_job_is_reported() {
        let registry = JobRegistry::silent();
        let error = registry.request_cancel("nope").expect_err("unknown job");
        assert_eq!(error.kind(), "job_not_found");
    }

    #[test]
    fn a_cancelled_worker_is_not_recorded_as_a_failure() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        registry.finish(&id, Err(AppError::JobCancelled));

        let snapshot = registry.snapshot(&id).expect("snapshot");
        assert_eq!(snapshot.status, JobStatus::Cancelled);
        assert!(
            snapshot.error.is_none(),
            "cancelling is a user action, not an error"
        );
    }

    #[test]
    fn a_failure_carries_the_typed_error_envelope() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        registry.finish(
            &id,
            Err(AppError::FfmpegUnavailable("not installed".into())),
        );

        let error = registry
            .snapshot(&id)
            .expect("snapshot")
            .error
            .expect("error envelope");
        assert_eq!(error.kind, "ffmpeg_unavailable");
        assert!(error.message.contains("not installed"));
    }

    #[test]
    fn a_retryable_failure_is_flagged_for_the_retry_affordance() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        registry.finish(
            &id,
            Err(AppError::ToolFailed {
                tool: "ffmpeg".into(),
                code: "1".into(),
                stderr: "transient".into(),
            }),
        );

        let error = registry
            .snapshot(&id)
            .expect("snapshot")
            .error
            .expect("error envelope");
        assert!(error.retryable);
    }

    #[test]
    fn a_skipped_job_reports_a_reason_and_no_error() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        registry.mark_skipped(&id, "asset has no audio stream");

        let snapshot = registry.snapshot(&id).expect("snapshot");
        assert_eq!(snapshot.status, JobStatus::Skipped);
        assert_eq!(
            snapshot.message.as_deref(),
            Some("asset has no audio stream")
        );
        assert!(snapshot.error.is_none());
    }

    #[test]
    fn jobs_are_listed_newest_first() {
        let registry = JobRegistry::silent();
        let first = registry.create(JobKind::Thumbnail, "first".into(), None);
        let second = registry.create(JobKind::Proxy, "second".into(), None);

        let listed: Vec<String> = registry.list().into_iter().map(|job| job.id).collect();
        assert_eq!(listed, vec![second, first]);
    }

    #[test]
    fn clearing_finished_jobs_leaves_running_work_alone() {
        let registry = JobRegistry::silent();
        let done = create(&registry);
        let running = create(&registry);
        registry.mark_completed(&done, None);
        registry.mark_running(&running);

        assert_eq!(registry.clear_finished(), 1);
        assert!(registry.snapshot(&done).is_none());
        assert!(registry.snapshot(&running).is_some());
        assert_eq!(registry.list().len(), 1);
    }

    #[test]
    fn derivative_kinds_map_onto_job_kinds() {
        assert_eq!(JobKind::from(DerivativeKind::Proxy), JobKind::Proxy);
        assert_eq!(JobKind::from(DerivativeKind::Waveform), JobKind::Waveform);
        assert_eq!(JobKind::from(DerivativeKind::Thumbnail), JobKind::Thumbnail);
        assert_eq!(JobKind::from(DerivativeKind::Filmstrip), JobKind::Filmstrip);
    }

    #[test]
    fn updating_an_unknown_job_is_a_no_op_rather_than_a_panic() {
        let registry = JobRegistry::silent();
        registry.mark_running("nope");
        registry.report_progress("nope", 0.5);
        registry.mark_completed("nope", None);
        assert!(registry.list().is_empty());
    }

    #[test]
    fn snapshots_serialize_with_camel_case_keys_for_the_frontend() {
        let registry = JobRegistry::silent();
        let id = create(&registry);
        let encoded =
            serde_json::to_string(&registry.snapshot(&id).expect("snapshot")).expect("encode");

        assert!(encoded.contains("\"mediaAssetId\""));
        assert!(encoded.contains("\"createdAt\""));
        assert!(encoded.contains("\"status\":\"queued\""));
    }

    #[test]
    fn the_history_limit_bounds_retained_finished_jobs() {
        let registry = JobRegistry::silent();
        for _ in 0..(FINISHED_HISTORY_LIMIT + 25) {
            let id = registry.create(JobKind::Thumbnail, "t".into(), None);
            registry.mark_completed(&id, None);
        }
        assert!(registry.list().len() <= FINISHED_HISTORY_LIMIT + 1);
    }
}
