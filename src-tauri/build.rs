fn main() {
    // Surface the Rust target triple at compile time so lib.rs can locate
    // the bundled `aethon-agent-<triple>` sidecar without re-deriving the
    // triple at runtime. Cargo sets TARGET on every build script invocation
    // and matches the suffix Tauri's externalBin bundler uses, so the two
    // stay in lockstep.
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=AETHON_TARGET_TRIPLE={triple}");

    // Tauri's build script validates that every `bundle.externalBin` file
    // exists for the active target before this script returns. Since the
    // sidecar is gitignored (~70 MB platform-specific), a clean checkout
    // would fail `cargo check` / `cargo tauri dev` until someone ran
    // build-agent.sh. Auto-bootstrap it here so any cargo flow just works.
    //
    // The script itself is fast (~150 ms) when bun's bundle cache is hot;
    // the heavy work (downloading the bun toolchain for cross-targets) only
    // runs the first time a new triple is requested. Skip when the binary
    // is already present so subsequent builds aren't slowed.
    let suffix = if triple.contains("windows") { ".exe" } else { "" };
    let bin_path = format!("binaries/aethon-agent-{triple}{suffix}");
    if !std::path::Path::new(&bin_path).exists() {
        let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let project_root = std::path::Path::new(&manifest_dir).parent().unwrap();
        let script = project_root.join("scripts").join("build-agent.sh");
        println!(
            "cargo:warning=aethon-agent sidecar missing; running {}",
            script.display()
        );
        let status = std::process::Command::new("bash")
            .arg(&script)
            .arg(format!("--target={triple}"))
            .current_dir(project_root)
            .status();
        match status {
            Ok(s) if s.success() => {}
            Ok(s) => {
                println!("cargo:warning=build-agent.sh exited with {s}");
            }
            Err(e) => {
                println!("cargo:warning=failed to spawn build-agent.sh: {e}");
            }
        }
    }
    println!("cargo:rerun-if-changed={bin_path}");

    tauri_build::build();
}
