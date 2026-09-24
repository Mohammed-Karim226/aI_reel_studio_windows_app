use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::timeline::{invalid, Timeline};

#[tauri::command]
pub fn load_timeline(
    state: State<'_, AppState>,
    project_id: String,
) -> AppResult<Option<Timeline>> {
    state.with_project(|project| {
        if project.summary.id != project_id {
            return Err(invalid("the active project changed"));
        }
        crate::db::timeline::load(&project.db)
    })
}

#[tauri::command]
pub fn save_timeline(
    state: State<'_, AppState>,
    project_id: String,
    timeline: Timeline,
) -> AppResult<()> {
    state.with_project(|project| {
        if project.summary.id != project_id {
            return Err(invalid(
                "the active project changed; timeline was not saved",
            ));
        }
        crate::db::timeline::save(&project.db, &timeline)
    })
}
