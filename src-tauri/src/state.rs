//! Application state shared by every IPC command.
//!
//! One [`AppState`] is managed by Tauri for the process lifetime. It owns the application-level
//! database, the currently open project, the resolved FFmpeg installation, and the job registry
//! that every background worker reports through.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::Connection;
use tauri::{AppHandle, Emitter, Manager};
use tracing::{info, warn};

use crate::db::projects::{ProjectFormat, ProjectSummary};
use crate::db::{self, settings};
use crate::error::{AppError, AppResult};
use crate::jobs::{JobEmitter, JobRegistry, JobSnapshot, JOB_EVENT};
use crate::logging::{self, category};
use crate::media::ffmpeg::{self, DiscoveryInputs, FfmpegTools};

/// Where the application keeps its own data, independent of any project (spec §25).
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub app_db: PathBuf,
    pub log_dir: PathBuf,
    /// Parent directory offered when the user creates a project without choosing one.
    pub default_projects_dir: PathBuf,
}

impl AppPaths {
    fn resolve(app: &AppHandle) -> AppResult<Self> {
        let data_dir = app.path().app_data_dir().map_err(|error| {
            AppError::Internal(format!("no application data directory: {error}"))
        })?;

        // Documents may be redirected or unavailable; the app data directory is always writable.
        let documents = app
            .path()
            .document_dir()
            .unwrap_or_else(|_| data_dir.clone());

        Ok(Self {
            app_db: data_dir.join("app.db"),
            log_dir: data_dir.join("logs"),
            default_projects_dir: documents.join("AI Reel Studio"),
            data_dir,
        })
    }

    /// Directory next to the executable, checked for a bundled FFmpeg pair.
    pub fn bundled_dir(&self) -> Option<PathBuf> {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
    }
}

/// A project that is currently open in the editor.
pub struct OpenProject {
    pub summary: ProjectSummary,
    pub root: PathBuf,
    pub format: ProjectFormat,
    /// Dedicated connection to `<root>/project.db`. Workers open their own connections.
    pub db: Connection,
}

pub struct AppState {
    paths: AppPaths,
    app_db: Mutex<Connection>,
    project: Mutex<Option<OpenProject>>,
    jobs: Arc<JobRegistry>,
    ffmpeg: Mutex<FfmpegCache>,
    /// Held so the non-blocking log appender flushes on shutdown.
    _log_guard: Mutex<Option<tracing_appender::non_blocking::WorkerGuard>>,
}

/// Discovery result cache.
///
/// A failed discovery is cached too: re-scanning `PATH` and spawning `ffmpeg -version` on every
/// call would freeze the window on a machine where FFmpeg is not installed.
#[derive(Default)]
struct FfmpegCache {
    tools: Option<FfmpegTools>,
    error: Option<String>,
}

impl FfmpegCache {
    fn tools(&self) -> Option<FfmpegTools> {
        self.tools.clone()
    }

    fn error(&self) -> Option<AppError> {
        self.error.clone().map(AppError::FfmpegUnavailable)
    }

    fn remember_success(&mut self, tools: &FfmpegTools) {
        self.tools = Some(tools.clone());
        self.error = None;
    }

    fn remember_failure(&mut self, error: &AppError) {
        self.tools = None;
        self.error = Some(error.to_string());
    }
}

/// Forwards job snapshots to the WebView. The registry itself knows nothing about Tauri.
struct TauriJobEmitter {
    app: AppHandle,
}

impl JobEmitter for TauriJobEmitter {
    fn emit(&self, snapshot: &JobSnapshot) {
        if let Err(error) = self.app.emit(JOB_EVENT, snapshot) {
            warn!(
                target: category::SYSTEM,
                job = %snapshot.id,
                "could not deliver job update: {error}"
            );
        }
    }
}

impl AppState {
    pub fn new(app: &AppHandle) -> AppResult<Self> {
        let paths = AppPaths::resolve(app)?;

        let log_guard = logging::init(&paths.log_dir)?;
        info!(
            target: category::SYSTEM,
            data_dir = %paths.data_dir.display(),
            version = env!("CARGO_PKG_VERSION"),
            "AI Reel Studio starting"
        );

        let conn = db::open_app_db(&paths.app_db)?;

        Ok(Self {
            paths,
            app_db: Mutex::new(conn),
            project: Mutex::new(None),
            jobs: Arc::new(JobRegistry::new(Box::new(TauriJobEmitter {
                app: app.clone(),
            }))),
            ffmpeg: Mutex::new(FfmpegCache::default()),
            _log_guard: Mutex::new(Some(log_guard)),
        })
    }

    pub fn paths(&self) -> &AppPaths {
        &self.paths
    }

    pub fn app_db(&self) -> MutexGuard<'_, Connection> {
        lock(&self.app_db)
    }

    /// Shared job registry. Cloning the `Arc` is how worker threads report progress.
    pub fn jobs(&self) -> Arc<JobRegistry> {
        Arc::clone(&self.jobs)
    }

    /// The resolved FFmpeg installation, discovered on first use and cached until reconfigured.
    /// Failures are cached as well, so a missing installation does not re-run discovery on every
    /// call.
    pub fn ffmpeg(&self) -> AppResult<FfmpegTools> {
        {
            let cache = lock(&self.ffmpeg);
            if let Some(tools) = cache.tools() {
                return Ok(tools);
            }
            if let Some(error) = cache.error() {
                return Err(error);
            }
        }

        let (configured_ffmpeg, configured_ffprobe) = {
            let conn = self.app_db();
            (
                settings::get(&conn, settings::keys::FFMPEG_PATH)?.map(PathBuf::from),
                settings::get(&conn, settings::keys::FFPROBE_PATH)?.map(PathBuf::from),
            )
        };

        let inputs = DiscoveryInputs::from_environment(
            configured_ffmpeg,
            configured_ffprobe,
            self.paths.bundled_dir(),
        );

        match ffmpeg::resolve(&inputs) {
            Ok(tools) => {
                lock(&self.ffmpeg).remember_success(&tools);
                Ok(tools)
            }
            Err(error) => {
                lock(&self.ffmpeg).remember_failure(&error);
                Err(error)
            }
        }
    }

    /// Forgets the cached installation so the next call re-discovers it.
    pub fn clear_ffmpeg_cache(&self) {
        *lock(&self.ffmpeg) = FfmpegCache::default();
    }

    pub fn set_project(&self, project: Option<OpenProject>) {
        let mut current = lock(&self.project);
        *current = project;
    }

    /// Runs `f` against the open project, or fails with `no_project_open`.
    pub fn with_project<T>(&self, f: impl FnOnce(&OpenProject) -> AppResult<T>) -> AppResult<T> {
        let guard = lock(&self.project);
        let project = guard.as_ref().ok_or(AppError::NoProjectOpen)?;
        f(project)
    }

    pub fn project_root(&self) -> AppResult<PathBuf> {
        self.with_project(|project| Ok(project.root.clone()))
    }
}

/// Recovers from a poisoned mutex instead of permanently disabling the app: a panic in a command
/// must not take the editor down with it.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        warn!(target: category::SYSTEM, "app state mutex was poisoned; recovering");
        poisoned.into_inner()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failed_discovery_is_cached_and_reported_verbatim() {
        let mut cache = FfmpegCache::default();
        assert!(cache.tools().is_none());
        assert!(cache.error().is_none());

        let error = AppError::FfmpegUnavailable(
            "ffmpeg.exe and ffprobe.exe were not found. Searched: C:\\Windows".into(),
        );
        cache.remember_failure(&error);

        let cached = cache.error().expect("cached failure");
        assert_eq!(cached.kind(), "ffmpeg_unavailable");
        assert_eq!(cached.to_string(), error.to_string());
        assert!(cache.tools().is_none());
    }

    #[test]
    fn a_successful_discovery_clears_an_earlier_failure() {
        let mut cache = FfmpegCache::default();
        cache.remember_failure(&AppError::FfmpegUnavailable("not installed".into()));

        let tools = FfmpegTools {
            ffmpeg_path: r"C:\ffmpeg\ffmpeg.exe".into(),
            ffprobe_path: r"C:\ffmpeg\ffprobe.exe".into(),
            version: "7.1".into(),
            source: crate::media::ffmpeg::ToolSource::SystemPath,
        };
        cache.remember_success(&tools);

        assert!(cache.error().is_none());
        assert_eq!(cache.tools().expect("tools").version, "7.1");
    }
}
