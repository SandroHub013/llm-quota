/**
 * Application commands are allowed for local windows by default and refused for a remote
 * one — and the dashboard is remote: the sidecar serves it over loopback. Without this
 * the update notice draws itself from the event it is allowed to hear, and then answers
 * "Command install_update not allowed by ACL" when someone presses the button.
 *
 * Declaring them here is what generates the permissions the capability grants. The list
 * is the whole IPC surface this app exposes; anything not on it cannot be called at all.
 */
fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "pending_update",
                "install_update",
                "open_release_page",
                "open_widget",
            ]),
        ),
    )
    .expect("the Tauri build script failed");
}
