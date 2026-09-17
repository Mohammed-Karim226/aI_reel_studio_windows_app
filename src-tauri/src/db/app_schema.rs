use super::migrations::Migration;

/// Application-level database: settings, the project registry, and the *global* reusable
/// libraries (brands, hook templates, export presets) that are shared across projects.
///
/// Project-scoped entities live in each project's own `project.db` (see `project_schema`) so a
/// project directory stays portable and recoverable on its own (spec §25).
pub const APP_MIGRATIONS: [Migration; 1] = [Migration {
    version: 1,
    name: "app_foundation",
    sql: r#"
CREATE TABLE app_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE project_registry (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    root_path      TEXT NOT NULL UNIQUE,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL,
    last_opened_at TEXT
);

CREATE INDEX idx_project_registry_last_opened
    ON project_registry (last_opened_at DESC);

CREATE TABLE brand_profiles (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    builtin         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE hook_templates (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    category        TEXT NOT NULL,
    hook_type       TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    builtin         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_hook_templates_category ON hook_templates (category);

CREATE TABLE export_presets (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    platform        TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    builtin         INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX idx_export_presets_platform ON export_presets (platform);
"#,
}];
