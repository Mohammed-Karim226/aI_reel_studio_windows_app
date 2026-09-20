//! IPC surface.
//!
//! Commands stay thin by design: they translate arguments, call the domain layer, and map errors.
//! No business rule lives here, which keeps every rule testable with plain `cargo test`.

pub mod jobs;
pub mod media;
pub mod projects;
pub mod system;
pub mod timeline;
