//! AI Reel Studio — Tauri backend.
//!
//! Layering: `commands` (IPC surface) → `state` → domain modules (`project`, `media`, `jobs`,
//! `db`). Nothing below `commands` knows about Tauri, so the domain logic stays testable with
//! plain `cargo test`.

pub mod captions;
pub mod commands;
pub mod db;
pub mod error;
pub mod jobs;
pub mod logging;
pub mod media;
pub mod project;
pub mod state;
pub mod timeline;
pub mod transcription;

use serde::Serialize;
use tauri::Manager;

const APP_NAME: &str = "AI Reel Studio";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AppInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub platform: &'static str,
}

pub fn current_app_info() -> AppInfo {
    AppInfo {
        name: APP_NAME,
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let state = state::AppState::new(app.handle())?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::system::get_app_info,
            commands::system::get_settings,
            commands::system::set_setting,
            commands::system::remove_setting,
            commands::system::resolve_ffmpeg,
            commands::system::configure_ffmpeg,
            commands::system::recent_logs,
            commands::system::default_projects_dir,
            commands::projects::list_recent_projects,
            commands::projects::create_project,
            commands::projects::open_project,
            commands::projects::close_project,
            commands::projects::current_project,
            commands::projects::forget_project,
            commands::media::import_media,
            commands::media::list_media,
            commands::media::get_media,
            commands::media::remove_media,
            commands::media::plan_media_derivatives,
            commands::media::regenerate_derivative,
            commands::media::read_waveform,
            commands::jobs::list_jobs,
            commands::jobs::cancel_job,
            commands::jobs::clear_finished_jobs,
            commands::timeline::load_timeline,
            commands::timeline::save_timeline,
            commands::captions::transcribe_media,
            commands::captions::open_transcription_setup_folder,
            commands::captions::get_transcription_setup,
            commands::captions::save_transcription_setup,
            commands::captions::check_transcription_setup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn current_app_info_is_populated() {
        let info = current_app_info();
        assert_eq!(info.name, "AI Reel Studio");
        assert!(!info.version.is_empty());
        assert_eq!(info.platform, std::env::consts::OS);
    }
}
