//! Tauri command layer: thin wrappers over `ops`, `state`, `transfers` and `jobs`.

pub mod aws_login;
pub mod batches;
pub mod browse;
pub mod buckets;
pub mod connection;
pub mod files;
pub mod folder_size;
pub mod folders;
pub mod jobs;
pub mod lifecycle;
pub mod local;
pub mod metadata;
pub mod saved;
pub mod search;
pub mod settings;
pub mod tags;
pub mod transfers;
pub mod updates;
pub mod versions;
