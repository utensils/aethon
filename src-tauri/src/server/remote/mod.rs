//! Remote-client gateway (paired devices over the LAN).
//!
//! Grows the scaffold in `server/` into an authenticated transport for
//! companion clients (iOS app): TLS + pairing, a WebSocket protocol that
//! relays an allowlisted subset of the Tauri command surface, and an
//! event hub that fans Tauri events out to connected devices.

pub mod events;
