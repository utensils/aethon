fn main() {
    // Surface the Rust target triple at compile time so lib.rs can locate
    // the bundled `aethon-agent-<triple>` sidecar without re-deriving the
    // triple at runtime. Cargo sets TARGET on every build script invocation
    // and matches the suffix Tauri's externalBin bundler uses, so the two
    // stay in lockstep.
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=AETHON_TARGET_TRIPLE={triple}");
    tauri_build::build();
}
