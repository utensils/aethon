use std::path::Path;
#[cfg(target_os = "macos")]
use std::path::PathBuf;
use std::time::SystemTime;
#[cfg(target_os = "macos")]
use std::{env, process::Command};

/// Returns true if any agent source / build input is newer than `target`.
/// Walks `agent/` recursively and checks the lockfile + package.json so
/// dep upgrades trigger a rebuild too.
fn newer_than(project_root: &Path, target: &Path) -> std::io::Result<bool> {
    let target_mtime = target.metadata()?.modified()?;
    let inputs = [
        project_root.join("agent"),
        project_root.join("package.json"),
        project_root.join("bun.lock"),
    ];
    for input in &inputs {
        if newer_recursive(input, target_mtime)? {
            return Ok(true);
        }
    }
    Ok(false)
}

fn newer_recursive(path: &Path, target_mtime: SystemTime) -> std::io::Result<bool> {
    if !path.exists() {
        return Ok(false);
    }
    let meta = path.metadata()?;
    if meta.is_file() {
        return Ok(meta.modified()? > target_mtime);
    }
    if meta.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let e = entry?;
            if newer_recursive(&e.path(), target_mtime)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn main() {
    let triple = std::env::var("TARGET").unwrap_or_else(|_| "unknown".to_string());
    println!("cargo:rustc-env=AETHON_TARGET_TRIPLE={triple}");
    println!("cargo:rustc-check-cfg=cfg(desktop)");
    println!("cargo:rustc-check-cfg=cfg(mobile)");

    #[cfg(target_os = "macos")]
    if std::env::var_os("CARGO_FEATURE_VOICE").is_some() {
        compile_platform_speech_swift();
    }

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let project_root = Path::new(&manifest_dir).parent().unwrap().to_path_buf();
    let has_repo_sidecar_inputs =
        project_root.join("agent").exists() && project_root.join("package.json").exists();

    // Cargo only re-invokes build.rs when one of these paths changes.
    // Track agent source + build inputs, NOT the generated sidecar — listing
    // the binary itself causes an infinite rebuild loop because the
    // compile step rewrites it every invocation.
    println!("cargo:rerun-if-changed=../agent");
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../bun.lock");
    println!("cargo:rerun-if-changed=build.rs");

    if has_repo_sidecar_inputs {
        if let Err(msg) = ensure_sidecar(&project_root, &triple) {
            // Hard-fail so a stale sidecar from a previous successful build
            // can't ship in a release while the current agent source has
            // compile errors. tauri_build::build() runs after this, but
            // panicking here aborts the build script before it can.
            panic!("aethon-agent sidecar build failed: {msg}");
        }
        tauri_build::build();
    } else {
        println!(
            "cargo:warning=skipping aethon-agent sidecar build; repository-level agent inputs are absent"
        );
        println!("cargo:warning=skipping tauri bundle metadata generation for crate packaging");
    }
}

#[cfg(target_os = "macos")]
fn compile_platform_speech_swift() {
    let swiftc_available = Command::new("xcrun")
        .args(["--find", "swiftc"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !swiftc_available {
        panic!(
            "swiftc not found; the default voice feature requires Xcode/Swift to build the Apple Speech bridge on macOS. Install Xcode command line tools or build with --no-default-features."
        );
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("out dir"));
    let source = manifest_dir.join("macos").join("PlatformSpeech.swift");
    let library = out_dir.join("libaethon_platform_speech.a");
    let sdk_path = command_stdout("xcrun", &["--sdk", "macosx", "--show-sdk-path"]);
    let target = swift_target();

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-parse-as-library",
            "-O",
            "-emit-library",
            "-static",
        ])
        .args(["-sdk", sdk_path.trim()])
        .args(["-target", &target])
        .arg(&source)
        .arg("-o")
        .arg(&library)
        .status()
        .expect("failed to invoke swiftc for PlatformSpeech.swift");
    assert!(status.success(), "swiftc failed for PlatformSpeech.swift");

    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rustc-link-search=native={}", out_dir.display());
    println!(
        "cargo:rustc-link-search=native={}",
        swift_runtime_path().display()
    );
    println!(
        "cargo:rustc-link-search=framework={}/System/Library/Frameworks",
        sdk_path.trim()
    );
    println!("cargo:rustc-link-lib=static=aethon_platform_speech");
    println!("cargo:rustc-link-lib=framework=Speech");
    println!("cargo:rustc-link-lib=framework=AVFoundation");
    println!("cargo:rustc-link-lib=framework=Foundation");
}

#[cfg(target_os = "macos")]
fn swift_target() -> String {
    let target = env::var("TARGET").expect("target triple");
    let arch = if target.starts_with("aarch64") {
        "arm64"
    } else if target.starts_with("x86_64") {
        "x86_64"
    } else {
        panic!("unsupported macOS target for Swift bridge: {target}");
    };
    format!("{arch}-apple-macosx11.0")
}

#[cfg(target_os = "macos")]
fn command_stdout(program: &str, args: &[&str]) -> String {
    let output = Command::new(program)
        .args(args)
        .output()
        .unwrap_or_else(|err| panic!("failed to run {program}: {err}"));
    assert!(
        output.status.success(),
        "{program} failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).expect("utf8 command output")
}

#[cfg(target_os = "macos")]
fn swift_runtime_path() -> PathBuf {
    let swiftc = PathBuf::from(command_stdout("xcrun", &["--find", "swiftc"]).trim());
    let bin = swiftc.parent().expect("swiftc bin dir");
    let toolchain_usr = bin.parent().expect("Swift toolchain usr dir");
    toolchain_usr.join("lib").join("swift").join("macosx")
}

/// Compile `agent/main.ts` into a self-contained `bun build --compile`
/// executable for the active Cargo target, and copy pi-coding-agent's
/// package.json into a sibling `pi/` dir for `PI_PACKAGE_DIR` lookup at
/// runtime. Mirrors what the `build-agent` devshell helper used to do
/// from a shell script — re-implemented in Rust so native Windows
/// builds (which don't have bash) work the same way.
fn ensure_sidecar(project_root: &Path, triple: &str) -> Result<(), String> {
    let bun_target = match triple {
        "aarch64-apple-darwin" => "bun-darwin-arm64",
        "x86_64-apple-darwin" => "bun-darwin-x64",
        "x86_64-unknown-linux-gnu" => "bun-linux-x64",
        "aarch64-unknown-linux-gnu" => "bun-linux-arm64",
        "x86_64-pc-windows-msvc" => "bun-windows-x64",
        other => return Err(format!("no bun target mapping for triple {other}")),
    };
    let suffix = if triple.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let out_dir = project_root.join("src-tauri").join("binaries");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("create_dir_all {}: {e}", out_dir.display()))?;
    let out_name = format!("aethon-agent-{triple}{suffix}");
    let out_path = out_dir.join(&out_name);

    // Skip the bun compile when the binary is already newer than every
    // tracked source. This makes incremental cargo builds free even
    // though build.rs may be re-invoked by Cargo for unrelated reasons
    // (tauri_build registers its own rerun paths). When sources DO
    // change, our own rerun-if-changed entries trigger and the mtime
    // check correctly forces a rebuild.
    let needs_build = !out_path.exists()
        || newer_than(project_root, &out_path).map_err(|e| format!("source mtime check: {e}"))?;
    if needs_build {
        println!(
            "cargo:warning=building aethon-agent sidecar → {} (target={bun_target})",
            out_path.display()
        );
        let status = std::process::Command::new("bun")
            .args([
                "build",
                "agent/main.ts",
                "--compile",
                "--sourcemap=none",
                &format!("--target={bun_target}"),
                "--outfile",
            ])
            .arg(&out_path)
            .current_dir(project_root)
            .status()
            .map_err(|e| format!("spawn bun: {e}"))?;
        if !status.success() {
            return Err(format!("bun build exited with {status}"));
        }
    }

    // pi-coding-agent reads its own package.json at module load. Copy
    // alongside the binary in a `pi/` subdir; the Rust spawn path sets
    // PI_PACKAGE_DIR so getPackageDir() finds it without the original
    // node_modules tree.
    let pi_pkg = project_root
        .join("node_modules")
        .join("@mariozechner")
        .join("pi-coding-agent")
        .join("package.json");
    if pi_pkg.exists() {
        let pi_out = out_dir.join("pi");
        std::fs::create_dir_all(&pi_out)
            .map_err(|e| format!("create_dir_all {}: {e}", pi_out.display()))?;
        std::fs::copy(&pi_pkg, pi_out.join("package.json"))
            .map_err(|e| format!("copy pi package.json: {e}"))?;
    } else {
        return Err(format!(
            "pi package.json not found at {} — run `bun install`",
            pi_pkg.display()
        ));
    }
    Ok(())
}
