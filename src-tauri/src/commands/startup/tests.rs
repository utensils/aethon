use super::approval::{
    ApprovalStore, ProjectRegistry, ProjectRegistryProject, ProjectRegistryWorkspace,
    project_auto_approve_for_root,
};
use super::status::StartupApprovalPolicy;
use super::*;

fn policy(approved: bool) -> StartupApprovalPolicy {
    StartupApprovalPolicy {
        approved,
        auto_approve: false,
        host_auto_approve: false,
        project_auto_approve: false,
    }
}

fn approval_store_for(path: &Path) -> ApprovalStore {
    ApprovalStore {
        auto_approve_roots: BTreeMap::from([(path.display().to_string(), true)]),
        ..ApprovalStore::default()
    }
}

#[test]
fn parse_startup_config_defaults_commands_to_required() {
    let cfg = parse_startup_config(
        r#"[startup]
timeout_seconds = 42

[[startup.commands]]
id = "deps"
label = "Install dependencies"
command = "bun install"
"#,
    );

    assert_eq!(cfg.timeout_seconds, 42);
    assert_eq!(cfg.commands.len(), 1);
    assert_eq!(cfg.commands[0].id, "deps");
    assert_eq!(cfg.commands[0].label, "Install dependencies");
    assert_eq!(cfg.commands[0].command, "bun install");
    assert!(cfg.commands[0].required);
    assert_eq!(cfg.commands[0].timeout_seconds, 42);
}

#[test]
fn parse_startup_config_ignores_project_auto_approve() {
    let cfg = parse_startup_config(
        r#"[startup]
auto_approve = true

[[startup.commands]]
command = "bun install"
"#,
    );

    assert!(!cfg.auto_approve);
    assert_eq!(cfg.commands.len(), 1);
    assert!(
        cfg.warning
            .as_deref()
            .is_some_and(|warning| warning.contains("Ignored [startup].auto_approve"))
    );
}

#[test]
fn parse_startup_config_honors_optional_and_per_command_timeout() {
    let cfg = parse_startup_config(
        r#"[startup]
timeout_seconds = 600

[[startup.commands]]
id = "assets"
command = "bun run assets"
required = false
timeout_seconds = 5
"#,
    );

    assert_eq!(cfg.commands.len(), 1);
    assert!(!cfg.commands[0].required);
    assert_eq!(cfg.commands[0].timeout_seconds, 5);
}

#[test]
fn startup_fingerprint_changes_when_command_changes() {
    let a = startup_fingerprint(&parse_startup_config(
        r#"[[startup.commands]]
id = "deps"
command = "bun install"
"#,
    ));
    let b = startup_fingerprint(&parse_startup_config(
        r#"[[startup.commands]]
id = "deps"
command = "bun install --frozen-lockfile"
"#,
    ));

    assert_ne!(a, b);
}

#[test]
fn status_response_keeps_environment_task_visible_after_approval_gate() {
    let cfg = parse_startup_config(
        r#"[[startup.commands]]
id = "deps"
command = "bun install"
"#,
    );
    let fingerprint = startup_fingerprint(&cfg);
    let response = status_response(
        Path::new("/tmp/example"),
        &cfg,
        &fingerprint,
        policy(false),
        Some(StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::ApprovalRequired,
            reason: Some("startup commands require approval".to_string()),
            active_task_id: None,
            task_states: BTreeMap::new(),
        }),
    );

    assert_eq!(response.state, "approval_required");
    assert_eq!(response.commands[0].id, STARTUP_DEVSHELL_TASK_ID);
    assert_eq!(response.commands[0].state, "ready");
    assert_eq!(response.commands[1].id, "deps");
    assert_eq!(response.commands[1].state, "idle");
}

#[test]
fn status_response_marks_failed_startup_command() {
    let cfg = parse_startup_config(
        r#"[[startup.commands]]
id = "deps"
command = "bun install"
"#,
    );
    let fingerprint = startup_fingerprint(&cfg);
    let response = status_response(
        Path::new("/tmp/example"),
        &cfg,
        &fingerprint,
        policy(true),
        Some(StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Failed,
            reason: Some("deps exited with 1".to_string()),
            active_task_id: Some("deps".to_string()),
            task_states: BTreeMap::from([("deps".to_string(), StartupState::Failed)]),
        }),
    );

    assert_eq!(response.state, "failed");
    assert_eq!(response.commands[0].state, "idle");
    assert_eq!(response.commands[1].state, "failed");
}

#[test]
fn status_response_marks_failed_environment_task() {
    let cfg = parse_startup_config("");
    let fingerprint = startup_fingerprint(&cfg);
    let response = status_response(
        Path::new("/tmp/example"),
        &cfg,
        &fingerprint,
        policy(true),
        Some(StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Failed,
            reason: Some("devshell prepare failed".to_string()),
            active_task_id: Some(STARTUP_DEVSHELL_TASK_ID.to_string()),
            task_states: BTreeMap::new(),
        }),
    );

    assert_eq!(response.state, "failed");
    assert_eq!(response.commands.len(), 1);
    assert_eq!(response.commands[0].id, STARTUP_DEVSHELL_TASK_ID);
    assert_eq!(response.commands[0].state, "failed");
}

#[test]
fn malformed_startup_config_surfaces_failed_status() {
    let cfg = parse_startup_config("[startup\ncommands = [");
    let fingerprint = startup_fingerprint(&cfg);
    let response = status_response(
        Path::new("/tmp/example"),
        &cfg,
        &fingerprint,
        policy(true),
        None,
    );

    assert_eq!(response.state, "failed");
    assert!(
        response
            .warning
            .as_deref()
            .is_some_and(|warning| warning.contains("Could not parse"))
    );
    assert!(
        response
            .reason
            .as_deref()
            .is_some_and(|reason| reason.contains("startup commands were not run"))
    );
}

#[test]
fn status_response_preserves_optional_command_failure_after_overall_ready() {
    let cfg = parse_startup_config(
        r#"[[startup.commands]]
id = "assets"
command = "bun run assets"
required = false

[[startup.commands]]
id = "deps"
command = "bun install"
"#,
    );
    let fingerprint = startup_fingerprint(&cfg);
    let response = status_response(
        Path::new("/tmp/example"),
        &cfg,
        &fingerprint,
        policy(true),
        Some(StartupRecord {
            fingerprint: fingerprint.clone(),
            state: StartupState::Ready,
            reason: None,
            active_task_id: None,
            task_states: BTreeMap::from([
                ("assets".to_string(), StartupState::Failed),
                ("deps".to_string(), StartupState::Ready),
            ]),
        }),
    );

    assert_eq!(response.state, "ready");
    assert_eq!(response.commands[1].id, "assets");
    assert_eq!(response.commands[1].state, "failed");
    assert_eq!(response.commands[2].id, "deps");
    assert_eq!(response.commands[2].state, "ready");
}

#[test]
fn status_response_reports_auto_approve_sources() {
    let cfg = parse_startup_config(
        r#"[[startup.commands]]
command = "bun install"
"#,
    );
    let fingerprint = startup_fingerprint(&cfg);
    let response = status_response(
        Path::new("/tmp/example"),
        &cfg,
        &fingerprint,
        StartupApprovalPolicy {
            approved: true,
            auto_approve: true,
            host_auto_approve: true,
            project_auto_approve: false,
        },
        None,
    );

    assert!(response.approved);
    assert!(response.auto_approve);
    assert!(response.host_auto_approve);
    assert!(!response.project_auto_approve);
    assert_eq!(response.state, "idle");
}

#[test]
fn project_auto_approve_inherits_for_persisted_workspaces() {
    let temp = tempfile::tempdir().expect("tempdir");
    let project = temp.path().join("nyc-real-estate");
    let workspace = temp
        .path()
        .join("workspaces")
        .join("fix-issue-632-admin-tracked-urls");
    std::fs::create_dir_all(&project).expect("project dir");
    std::fs::create_dir_all(&workspace).expect("workspace dir");
    let project = canonicalize_root(&project);
    let workspace = canonicalize_root(&workspace);
    let store = approval_store_for(&project);
    let registry = ProjectRegistry {
        projects: vec![ProjectRegistryProject {
            id: "project-1".to_string(),
            label: "nyc-real-estate".to_string(),
            path: project.display().to_string(),
        }],
        workspaces_by_project: BTreeMap::from([(
            "project-1".to_string(),
            vec![ProjectRegistryWorkspace {
                path: workspace.display().to_string(),
            }],
        )]),
    };

    assert!(project_auto_approve_for_root(
        &workspace,
        &store,
        Some(&registry),
        None
    ));
}

#[test]
fn project_auto_approve_inherits_for_aethon_managed_workspaces_before_persist() {
    let temp = tempfile::tempdir().expect("tempdir");
    let project = temp.path().join("nyc-real-estate");
    let aethon_dir = temp.path().join(".aethon");
    let workspace = aethon_dir
        .join("nyc-real-estate")
        .join("fix-issue-632-admin-tracked-urls");
    std::fs::create_dir_all(&project).expect("project dir");
    std::fs::create_dir_all(&workspace).expect("workspace dir");
    let project = canonicalize_root(&project);
    let workspace = canonicalize_root(&workspace);
    let aethon_dir = canonicalize_root(&aethon_dir);
    let store = approval_store_for(&project);
    let registry = ProjectRegistry {
        projects: vec![ProjectRegistryProject {
            id: "project-1".to_string(),
            label: "nyc-real-estate".to_string(),
            path: project.display().to_string(),
        }],
        ..ProjectRegistry::default()
    };

    assert!(project_auto_approve_for_root(
        &workspace,
        &store,
        Some(&registry),
        Some(&aethon_dir),
    ));
}

#[test]
fn project_auto_approve_does_not_match_similar_project_labels() {
    let temp = tempfile::tempdir().expect("tempdir");
    let project = temp.path().join("nyc-real-estate");
    let aethon_dir = temp.path().join(".aethon");
    let unrelated = aethon_dir
        .join("nyc-real-estate-extra")
        .join("fix-issue-632-admin-tracked-urls");
    std::fs::create_dir_all(&project).expect("project dir");
    std::fs::create_dir_all(&unrelated).expect("workspace dir");
    let project = canonicalize_root(&project);
    let unrelated = canonicalize_root(&unrelated);
    let aethon_dir = canonicalize_root(&aethon_dir);
    let store = approval_store_for(&project);
    let registry = ProjectRegistry {
        projects: vec![ProjectRegistryProject {
            id: "project-1".to_string(),
            label: "nyc-real-estate".to_string(),
            path: project.display().to_string(),
        }],
        ..ProjectRegistry::default()
    };

    assert!(!project_auto_approve_for_root(
        &unrelated,
        &store,
        Some(&registry),
        Some(&aethon_dir),
    ));
}

#[test]
fn truncate_utf8_keeps_char_boundary() {
    let input = format!("{}é", "a".repeat(STARTUP_CONFIG_MAX_BYTES - 1));
    let truncated = truncate_utf8(input, STARTUP_CONFIG_MAX_BYTES);

    assert_eq!(truncated.len(), STARTUP_CONFIG_MAX_BYTES - 1);
    assert!(truncated.is_char_boundary(truncated.len()));
}
