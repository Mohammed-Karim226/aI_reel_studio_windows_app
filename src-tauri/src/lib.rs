use serde::Serialize;

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

#[tauri::command]
fn get_app_info() -> AppInfo {
    current_app_info()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![get_app_info])
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
