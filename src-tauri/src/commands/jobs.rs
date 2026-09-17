//! Job panel commands (spec §23, §29).

use tauri::State;

use crate::error::AppResult;
use crate::jobs::JobSnapshot;
use crate::state::AppState;

#[tauri::command]
pub fn list_jobs(state: State<'_, AppState>) -> Vec<JobSnapshot> {
    state.jobs().list()
}

#[tauri::command]
pub fn cancel_job(state: State<'_, AppState>, job_id: String) -> AppResult<()> {
    state.jobs().request_cancel(&job_id)
}

#[tauri::command]
pub fn clear_finished_jobs(state: State<'_, AppState>) -> usize {
    state.jobs().clear_finished()
}
