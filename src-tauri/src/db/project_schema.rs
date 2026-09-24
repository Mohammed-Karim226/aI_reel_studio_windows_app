use super::migrations::Migration;

/// Per-project database, stored at `<project>/project.db`.
///
/// Holds every project-scoped entity from spec §26. Media binaries are never stored here — only
/// paths relative to the project root plus probed metadata (spec §26: "Never store massive video
/// binary data directly inside SQLite").
pub const PROJECT_MIGRATIONS: [Migration; 3] = [
    Migration {
        version: 1,
        name: "project_foundation",
        sql: r#"
CREATE TABLE project (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    format_width  INTEGER NOT NULL,
    format_height INTEGER NOT NULL,
    format_fps    REAL NOT NULL
);

-- ---------------------------------------------------------------- media

CREATE TABLE media_assets (
    id                 TEXT PRIMARY KEY,
    original_path      TEXT NOT NULL,
    file_name          TEXT NOT NULL,
    kind               TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'image')),
    container          TEXT,
    size_bytes         INTEGER NOT NULL,
    duration_sec       REAL NOT NULL,
    has_video          INTEGER NOT NULL,
    has_audio          INTEGER NOT NULL,
    video_codec        TEXT,
    width              INTEGER,
    height             INTEGER,
    display_width      INTEGER,
    display_height     INTEGER,
    fps                REAL,
    rotation           INTEGER NOT NULL DEFAULT 0,
    pix_fmt            TEXT,
    video_bit_rate     INTEGER,
    audio_codec        TEXT,
    audio_channels     INTEGER,
    audio_sample_rate  INTEGER,
    audio_bit_rate     INTEGER,
    probe_json         TEXT NOT NULL,
    imported_at        TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_media_assets_original_path ON media_assets (original_path);

-- Thumbnails, filmstrips, waveform peaks and proxies. `relative_path` is relative to the
-- project root so the whole project directory can be moved.
CREATE TABLE media_derivatives (
    id              TEXT PRIMARY KEY,
    media_asset_id  TEXT NOT NULL REFERENCES media_assets (id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('thumbnail', 'filmstrip', 'waveform', 'proxy')),
    status          TEXT NOT NULL CHECK (status IN ('pending', 'running', 'ready', 'failed')),
    relative_path   TEXT,
    params_json     TEXT NOT NULL,
    error           TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    UNIQUE (media_asset_id, kind)
);

-- ---------------------------------------------------------------- timeline

CREATE TABLE timelines (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    duration_sec REAL NOT NULL DEFAULT 0,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    fps          REAL NOT NULL,
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

CREATE TABLE tracks (
    id          TEXT PRIMARY KEY,
    timeline_id TEXT NOT NULL REFERENCES timelines (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('video', 'audio', 'text', 'captions', 'graphics', 'effects', 'sfx')),
    name        TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    locked      INTEGER NOT NULL DEFAULT 0,
    muted       INTEGER NOT NULL DEFAULT 0,
    solo        INTEGER NOT NULL DEFAULT 0,
    volume      REAL NOT NULL DEFAULT 1.0,
    UNIQUE (timeline_id, order_index)
);

CREATE TABLE timeline_clips (
    id              TEXT PRIMARY KEY,
    track_id        TEXT NOT NULL REFERENCES tracks (id) ON DELETE CASCADE,
    source_media_id TEXT REFERENCES media_assets (id) ON DELETE RESTRICT,
    label           TEXT,
    source_start    REAL NOT NULL,
    source_end      REAL NOT NULL,
    timeline_start  REAL NOT NULL,
    timeline_end    REAL NOT NULL,
    speed           REAL NOT NULL DEFAULT 1.0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    transform_json  TEXT NOT NULL,
    CHECK (source_end > source_start),
    CHECK (timeline_end > timeline_start)
);

CREATE INDEX idx_timeline_clips_track ON timeline_clips (track_id, timeline_start);

-- ---------------------------------------------------------------- captions and text

CREATE TABLE captions (
    id          TEXT PRIMARY KEY,
    timeline_id TEXT NOT NULL REFERENCES timelines (id) ON DELETE CASCADE,
    track_id    TEXT REFERENCES tracks (id) ON DELETE SET NULL,
    start_sec   REAL NOT NULL,
    end_sec     REAL NOT NULL,
    text        TEXT NOT NULL,
    language    TEXT NOT NULL DEFAULT 'en',
    direction   TEXT NOT NULL DEFAULT 'ltr' CHECK (direction IN ('ltr', 'rtl')),
    style       TEXT NOT NULL DEFAULT 'classic',
    style_json  TEXT NOT NULL,
    CHECK (end_sec > start_sec)
);

CREATE INDEX idx_captions_timeline ON captions (timeline_id, start_sec);

CREATE TABLE caption_words (
    id          TEXT PRIMARY KEY,
    caption_id  TEXT NOT NULL REFERENCES captions (id) ON DELETE CASCADE,
    text        TEXT NOT NULL,
    start_sec   REAL NOT NULL,
    end_sec     REAL NOT NULL,
    emphasis    INTEGER NOT NULL DEFAULT 0,
    order_index INTEGER NOT NULL,
    UNIQUE (caption_id, order_index)
);

CREATE TABLE text_elements (
    id             TEXT PRIMARY KEY,
    timeline_id    TEXT NOT NULL REFERENCES timelines (id) ON DELETE CASCADE,
    track_id       TEXT REFERENCES tracks (id) ON DELETE SET NULL,
    content        TEXT NOT NULL,
    role           TEXT NOT NULL DEFAULT 'body',
    start_sec      REAL NOT NULL,
    end_sec        REAL NOT NULL,
    style_json     TEXT NOT NULL,
    transform_json TEXT NOT NULL,
    CHECK (end_sec > start_sec)
);

-- ---------------------------------------------------------------- animation

-- `owner_type`/`owner_id` is a deliberate polymorphic edge: keyframes must be reusable across
-- clips, text, shapes, captions and effects (spec §10) without one FK column per owner kind.
CREATE TABLE animations (
    id         TEXT PRIMARY KEY,
    owner_type TEXT NOT NULL CHECK (owner_type IN ('clip', 'text', 'caption', 'effect', 'shape', 'hook_layer')),
    owner_id   TEXT NOT NULL,
    property   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (owner_type, owner_id, property)
);

CREATE TABLE keyframes (
    id           TEXT PRIMARY KEY,
    animation_id TEXT NOT NULL REFERENCES animations (id) ON DELETE CASCADE,
    time_sec     REAL NOT NULL,
    value_json   TEXT NOT NULL,
    easing       TEXT NOT NULL DEFAULT 'linear',
    easing_json  TEXT,
    UNIQUE (animation_id, time_sec)
);

-- ---------------------------------------------------------------- effects

CREATE TABLE effects (
    id          TEXT PRIMARY KEY,
    owner_type  TEXT NOT NULL CHECK (owner_type IN ('clip', 'text', 'caption', 'hook_layer', 'timeline')),
    owner_id    TEXT NOT NULL,
    effect_type TEXT NOT NULL,
    order_index INTEGER NOT NULL,
    enabled     INTEGER NOT NULL DEFAULT 1,
    params_json TEXT NOT NULL
);

CREATE INDEX idx_effects_owner ON effects (owner_type, owner_id, order_index);

-- ---------------------------------------------------------------- render and AI

CREATE TABLE render_jobs (
    id            TEXT PRIMARY KEY,
    timeline_id   TEXT REFERENCES timelines (id) ON DELETE SET NULL,
    preset_id     TEXT NOT NULL,
    platform      TEXT NOT NULL,
    quality_mode  TEXT NOT NULL,
    status        TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    progress      REAL NOT NULL DEFAULT 0,
    source_policy TEXT NOT NULL DEFAULT 'original' CHECK (source_policy IN ('original', 'proxy')),
    output_path   TEXT,
    error         TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
);

CREATE TABLE ai_analyses (
    id             TEXT PRIMARY KEY,
    media_asset_id TEXT REFERENCES media_assets (id) ON DELETE CASCADE,
    timeline_id    TEXT REFERENCES timelines (id) ON DELETE CASCADE,
    kind           TEXT NOT NULL,
    provider_id    TEXT NOT NULL,
    model          TEXT,
    status         TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    result_json    TEXT,
    error          TEXT,
    created_at     TEXT NOT NULL,
    finished_at    TEXT
);

CREATE TABLE ai_suggestions (
    id          TEXT PRIMARY KEY,
    analysis_id TEXT NOT NULL REFERENCES ai_analyses (id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    severity    TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
    message     TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'ignored')),
    created_at  TEXT NOT NULL
);

CREATE INDEX idx_ai_suggestions_analysis ON ai_suggestions (analysis_id);
"#,
    },
    Migration {
        version: 2,
        name: "timeline_hook_json",
        sql: r##"ALTER TABLE timelines ADD COLUMN hook_json TEXT NOT NULL DEFAULT '{"enabled":true,"duration":1.5,"background":"#111827","layers":[]}';"##,
    },
    Migration {
        version: 3,
        name: "timeline_captions_json",
        sql: r##"ALTER TABLE timelines ADD COLUMN captions_json TEXT NOT NULL DEFAULT '{"enabled":true,"style":{"preset":"classic","fontFamily":"Arial","fontSize":64,"fontWeight":700,"color":"#ffffff","highlightColor":"#fbbf24","outlineColor":"#000000","outlineWidth":2,"shadow":true,"background":"transparent","x":50,"y":78,"lineHeight":1.2,"maxWidth":86,"direction":"auto","animation":"none","highlighting":"none"},"segments":[]}';"##,
    },
];
