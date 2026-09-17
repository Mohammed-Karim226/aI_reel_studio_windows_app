use std::collections::{BTreeMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use chrono::Utc;
use serde::Serialize;
use tracing::field::{Field, Visit};
use tracing::{Event, Subscriber};
use tracing_subscriber::layer::{Context, Layer, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::EnvFilter;

/// Log categories from spec §30. Used as the `target` of every tracing macro call so the
/// diagnostics panel can filter by subsystem.
pub mod category {
    pub const MEDIA: &str = "media";
    pub const TIMELINE: &str = "timeline";
    pub const AI: &str = "ai";
    pub const RENDER: &str = "render";
    pub const EXPORT: &str = "export";
    pub const DATABASE: &str = "database";
    pub const SYSTEM: &str = "system";

    pub const ALL: [&str; 7] = [MEDIA, TIMELINE, AI, RENDER, EXPORT, DATABASE, SYSTEM];
}

const RING_CAPACITY: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub timestamp: String,
    pub level: String,
    pub category: String,
    pub message: String,
    pub fields: BTreeMap<String, String>,
}

/// In-memory ring of recent log records backing the developer diagnostics panel (spec §30).
/// Kept separate from the file appender so the UI never has to parse log files.
#[derive(Debug, Default)]
pub struct LogRing {
    records: Mutex<VecDeque<LogRecord>>,
}

impl LogRing {
    pub fn push(&self, record: LogRecord) {
        let Ok(mut records) = self.records.lock() else {
            return;
        };
        if records.len() == RING_CAPACITY {
            records.pop_front();
        }
        records.push_back(record);
    }

    /// Most recent records last. `category` of `None` returns every category.
    pub fn recent(&self, limit: usize, category: Option<&str>) -> Vec<LogRecord> {
        let Ok(records) = self.records.lock() else {
            return Vec::new();
        };

        let mut filtered: Vec<LogRecord> = records
            .iter()
            .filter(|record| category.is_none_or(|wanted| record.category == wanted))
            .cloned()
            .collect();

        if filtered.len() > limit {
            filtered.drain(..filtered.len() - limit);
        }
        filtered
    }

    pub fn len(&self) -> usize {
        self.records.lock().map(|r| r.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

fn ring() -> &'static Arc<LogRing> {
    static RING: OnceLock<Arc<LogRing>> = OnceLock::new();
    RING.get_or_init(|| Arc::new(LogRing::default()))
}

/// Shared handle to the process-wide log ring.
pub fn log_ring() -> Arc<LogRing> {
    Arc::clone(ring())
}

#[derive(Default)]
struct RecordVisitor {
    message: Option<String>,
    fields: BTreeMap<String, String>,
}

impl Visit for RecordVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = Some(rendered);
        } else {
            self.fields.insert(field.name().to_string(), rendered);
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.fields
                .insert(field.name().to_string(), value.to_string());
        }
    }
}

struct RingLayer {
    ring: Arc<LogRing>,
}

impl<S: Subscriber> Layer<S> for RingLayer {
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = RecordVisitor::default();
        event.record(&mut visitor);

        let metadata = event.metadata();
        let target = metadata.target();
        // Nested targets such as `media::proxy` collapse to their root category.
        let category = target.split("::").next().unwrap_or(target).to_string();

        self.ring.push(LogRecord {
            timestamp: Utc::now().to_rfc3339(),
            level: metadata.level().to_string(),
            category,
            message: visitor.message.unwrap_or_default(),
            fields: visitor.fields,
        });
    }
}

/// Installs the global subscriber: a rolling daily file appender plus the in-memory ring.
///
/// Returns the appender guard, which must be held for the process lifetime or buffered lines are
/// dropped on exit.
pub fn init(log_dir: &Path) -> std::io::Result<tracing_appender::non_blocking::WorkerGuard> {
    std::fs::create_dir_all(log_dir)?;

    let appender = tracing_appender::rolling::daily(log_dir, "ai-reel-studio.log");
    let (writer, guard) = tracing_appender::non_blocking(appender);

    let filter = EnvFilter::try_from_env("AI_REEL_STUDIO_LOG")
        .unwrap_or_else(|_| EnvFilter::new("info,tauri=warn,wry=warn"));

    let file_layer = tracing_subscriber::fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(true);

    tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(RingLayer { ring: log_ring() })
        .init();

    Ok(guard)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(category: &str, message: &str) -> LogRecord {
        LogRecord {
            timestamp: Utc::now().to_rfc3339(),
            level: "INFO".into(),
            category: category.into(),
            message: message.into(),
            fields: BTreeMap::new(),
        }
    }

    #[test]
    fn ring_keeps_newest_records_in_chronological_order() {
        let ring = LogRing::default();
        for index in 0..5 {
            ring.push(record(category::MEDIA, &format!("event {index}")));
        }

        let recent = ring.recent(3, None);
        assert_eq!(recent.len(), 3);
        assert_eq!(recent[0].message, "event 2");
        assert_eq!(recent[2].message, "event 4");
    }

    #[test]
    fn ring_filters_by_category() {
        let ring = LogRing::default();
        ring.push(record(category::MEDIA, "probe"));
        ring.push(record(category::DATABASE, "migrate"));
        ring.push(record(category::MEDIA, "proxy"));

        let media = ring.recent(10, Some(category::MEDIA));
        assert_eq!(media.len(), 2);
        assert!(media.iter().all(|r| r.category == category::MEDIA));
    }

    #[test]
    fn ring_is_bounded() {
        let ring = LogRing::default();
        for index in 0..(RING_CAPACITY + 50) {
            ring.push(record(category::SYSTEM, &format!("event {index}")));
        }
        assert_eq!(ring.len(), RING_CAPACITY);
        let recent = ring.recent(1, None);
        assert_eq!(
            recent[0].message,
            format!("event {}", RING_CAPACITY + 50 - 1)
        );
    }
}
