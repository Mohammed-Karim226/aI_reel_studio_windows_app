use std::collections::HashMap;

/// One reported progress block from `ffmpeg -progress pipe:1`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressUpdate {
    /// Position in the output stream, in seconds.
    pub out_time_sec: f64,
    pub frame: Option<u64>,
    pub fps: Option<f64>,
    /// Encoding speed relative to realtime, e.g. `4.2` for `speed=4.2x`.
    pub speed: Option<f64>,
    pub total_size: Option<u64>,
    /// True for the final block (`progress=end`).
    pub finished: bool,
}

impl ProgressUpdate {
    /// Fraction of the job completed, clamped to `0.0..=1.0`. A non-positive or unknown duration
    /// yields `None` so the UI can show an indeterminate state rather than a lying bar.
    pub fn fraction(&self, duration_sec: f64) -> Option<f64> {
        if self.finished {
            return Some(1.0);
        }
        if !duration_sec.is_finite() || duration_sec <= 0.0 {
            return None;
        }
        Some((self.out_time_sec / duration_sec).clamp(0.0, 1.0))
    }
}

/// Parses `HH:MM:SS.ffffff` timestamps.
fn parse_timestamp(value: &str) -> Option<f64> {
    let parts: Vec<&str> = value.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 3 {
        return None;
    }

    let mut seconds = 0.0_f64;
    for part in &parts {
        let component: f64 = part.trim().parse().ok()?;
        seconds = seconds * 60.0 + component;
    }
    Some(seconds)
}

/// Accumulates `key=value` lines until a `progress=` line closes the block.
///
/// ffmpeg writes progress as repeated blocks of key/value pairs, so a line-at-a-time parser has
/// to buffer until the terminator rather than react to individual keys.
#[derive(Debug, Default)]
pub struct ProgressParser {
    fields: HashMap<String, String>,
}

impl ProgressParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds one line. Returns an update only when the line completed a block.
    pub fn push_line(&mut self, line: &str) -> Option<ProgressUpdate> {
        let (key, value) = line.trim().split_once('=')?;
        let key = key.trim();
        let value = value.trim();

        if key != "progress" {
            self.fields.insert(key.to_string(), value.to_string());
            return None;
        }

        let update = ProgressUpdate {
            out_time_sec: self.out_time_sec(),
            frame: self.number("frame"),
            fps: self.float("fps"),
            speed: self.speed(),
            total_size: self.number("total_size"),
            finished: value == "end",
        };
        self.fields.clear();
        Some(update)
    }

    fn get(&self, key: &str) -> Option<&str> {
        // ffmpeg writes the literal string `N/A` before the first frame is encoded.
        self.fields
            .get(key)
            .map(String::as_str)
            .filter(|value| !value.is_empty() && *value != "N/A")
    }

    fn number(&self, key: &str) -> Option<u64> {
        self.get(key)?.parse().ok()
    }

    fn float(&self, key: &str) -> Option<f64> {
        self.get(key)?.parse().ok()
    }

    fn speed(&self) -> Option<f64> {
        self.get("speed")?.trim_end_matches('x').trim().parse().ok()
    }

    /// `out_time_ms` is a long-standing ffmpeg misnomer: it carries microseconds, exactly like
    /// `out_time_us`. Treating it as milliseconds would report progress 1000x too fast.
    fn out_time_sec(&self) -> f64 {
        if let Some(micros) = self.float("out_time_us") {
            return micros / 1_000_000.0;
        }
        if let Some(micros) = self.float("out_time_ms") {
            return micros / 1_000_000.0;
        }
        self.get("out_time")
            .and_then(parse_timestamp)
            .unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLOCK: &str = "frame=300\n\
fps=61.4\n\
stream_0_0_q=28.0\n\
bitrate=1200.4kbits/s\n\
total_size=1572864\n\
out_time_us=10000000\n\
out_time_ms=10000000\n\
out_time=00:00:10.000000\n\
dup_frames=0\n\
drop_frames=0\n\
speed=2.05x\n\
progress=continue";

    fn feed(parser: &mut ProgressParser, text: &str) -> Vec<ProgressUpdate> {
        text.lines()
            .filter_map(|line| parser.push_line(line))
            .collect()
    }

    #[test]
    fn a_block_yields_exactly_one_update_on_its_terminator() {
        let mut parser = ProgressParser::new();
        let updates = feed(&mut parser, BLOCK);
        assert_eq!(updates.len(), 1);

        let update = &updates[0];
        assert_eq!(update.out_time_sec, 10.0);
        assert_eq!(update.frame, Some(300));
        assert_eq!(update.fps, Some(61.4));
        assert_eq!(update.speed, Some(2.05));
        assert_eq!(update.total_size, Some(1_572_864));
        assert!(!update.finished);
    }

    #[test]
    fn out_time_ms_is_interpreted_as_microseconds() {
        // The ffmpeg key is misnamed; 30_000_000 "ms" is really 30 seconds.
        let mut parser = ProgressParser::new();
        let updates = feed(&mut parser, "out_time_ms=30000000\nprogress=continue");
        assert_eq!(updates[0].out_time_sec, 30.0);
    }

    #[test]
    fn the_timestamp_field_is_the_last_resort() {
        let mut parser = ProgressParser::new();
        let updates = feed(&mut parser, "out_time=00:01:30.500000\nprogress=continue");
        assert_eq!(updates[0].out_time_sec, 90.5);
    }

    #[test]
    fn not_available_values_are_ignored() {
        let mut parser = ProgressParser::new();
        let updates = feed(
            &mut parser,
            "frame=0\nfps=0.0\ntotal_size=N/A\nspeed=N/A\nout_time_us=0\nprogress=continue",
        );
        assert_eq!(updates[0].total_size, None);
        assert_eq!(updates[0].speed, None);
        assert_eq!(updates[0].out_time_sec, 0.0);
    }

    #[test]
    fn the_end_block_is_flagged_as_finished() {
        let mut parser = ProgressParser::new();
        let updates = feed(&mut parser, "out_time_us=60000000\nprogress=end");
        assert!(updates[0].finished);
        assert_eq!(updates[0].fraction(60.0), Some(1.0));
    }

    #[test]
    fn consecutive_blocks_do_not_leak_fields_into_each_other() {
        let mut parser = ProgressParser::new();
        let first = feed(
            &mut parser,
            "frame=10\nspeed=1.0x\nout_time_us=1000000\nprogress=continue",
        );
        let second = feed(&mut parser, "out_time_us=2000000\nprogress=continue");

        assert_eq!(first[0].frame, Some(10));
        assert_eq!(
            second[0].frame, None,
            "stale frame value must not carry over"
        );
        assert_eq!(second[0].speed, None);
        assert_eq!(second[0].out_time_sec, 2.0);
    }

    #[test]
    fn non_key_value_lines_are_ignored() {
        let mut parser = ProgressParser::new();
        assert!(parser.push_line("").is_none());
        assert!(parser.push_line("some banner text").is_none());
    }

    #[test]
    fn fraction_is_clamped_and_guards_unknown_durations() {
        let update = ProgressUpdate {
            out_time_sec: 90.0,
            frame: None,
            fps: None,
            speed: None,
            total_size: None,
            finished: false,
        };

        assert_eq!(update.fraction(180.0), Some(0.5));
        // ffmpeg can briefly report an out_time past the probed duration.
        assert_eq!(update.fraction(60.0), Some(1.0));
        assert_eq!(update.fraction(0.0), None);
        assert_eq!(update.fraction(f64::NAN), None);
    }

    #[test]
    fn timestamps_of_varying_precision_parse() {
        assert_eq!(parse_timestamp("00:00:05.5"), Some(5.5));
        assert_eq!(parse_timestamp("01:00:00.000000"), Some(3600.0));
        assert_eq!(parse_timestamp("12.25"), Some(12.25));
        assert_eq!(parse_timestamp("bogus"), None);
        assert_eq!(parse_timestamp("1:2:3:4"), None);
    }
}
