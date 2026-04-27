use std::path::Path;
use std::time::SystemTime;

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

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap();
    let project_root = Path::new(&manifest_dir).parent().unwrap().to_path_buf();

    // Cargo only re-invokes build.rs when one of these paths changes.
    // Track agent source + build inputs, NOT the generated sidecar — listing
    // the binary itself causes an infinite rebuild loop because the
    // compile step rewrites it every invocation.
    println!("cargo:rerun-if-changed=../agent");
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../bun.lock");
    println!("cargo:rerun-if-changed=build.rs");

    if let Err(msg) = ensure_sidecar(&project_root, &triple) {
        // Hard-fail so a stale sidecar from a previous successful build
        // can't ship in a release while the current agent source has
        // compile errors. tauri_build::build() runs after this, but
        // panicking here aborts the build script before it can.
        panic!("aethon-agent sidecar build failed: {msg}");
    }

    tauri_build::build();
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
    let suffix = if triple.contains("windows") { ".exe" } else { "" };
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
        || newer_than(project_root, &out_path)
            .map_err(|e| format!("source mtime check: {e}"))?;
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
