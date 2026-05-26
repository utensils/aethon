#[cfg(test)]
pub(crate) fn init_repo(path: &std::path::Path) {
    let init = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args(["-c", "init.defaultBranch=main", "init", "-q"])
        .status()
        .expect("git init");
    assert!(init.success(), "git init failed with status {init}");

    let commit = std::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .args([
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "-q",
            "-m",
            "init",
        ])
        .status()
        .expect("git commit");
    assert!(commit.success(), "git commit failed with status {commit}");
}
