fn main() {
    // Only these commands exist for pages; each one is a separate permission that a capability must grant.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            "desk_info",
            "desk_set_display",
            "desk_set_view",
            "desk_hide_helper",
            "desk_set_fullscreen",
            "desk_set_url",
            "agent_setup_info",
            "agent_pair_code",
            "agent_configure_network",
            "agent_retire_legacy",
            "agent_import_legacy",
            "agent_update_status",
            "agent_check_update",
            "agent_install_update",
        ])),
    )
    .expect("tauri build failed");
}
