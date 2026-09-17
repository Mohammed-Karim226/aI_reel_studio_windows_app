//! Media layer: everything that knows how to read a media file or derive an artifact from it.
//!
//! The rest of the application depends on the traits in [`engine`], not on ffmpeg. FFmpeg is
//! located at runtime ([`ffmpeg`]) and invoked as an external process; it is deliberately not
//! bundled in v1 (spec §34), so every entry point must cope with it being absent.

pub mod engine;
pub mod ffmpeg;
pub mod probe;
pub mod progress;
pub mod proxy;
pub mod runner;
pub mod thumbnail;
pub mod types;
pub mod waveform;
