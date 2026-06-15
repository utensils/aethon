//! Git, GitHub, worktree, issue, and project-picker commands.
//!
//! This module keeps the frontend-facing command names stable while the
//! implementation is split by command family. Local Git status/decorations,
//! worktree lifecycle, GitHub metadata, issue fetches, and native directory
//! picking each live in their own file.

pub mod checks;
pub(crate) mod common;
pub mod diff;
pub mod github;
pub mod issues;
pub mod picker;
pub mod status;
#[cfg(test)]
pub(crate) mod test_support;
pub mod watch;
pub mod worktrees;

pub use status::GitFetchState;
pub use watch::GitWatchState;
