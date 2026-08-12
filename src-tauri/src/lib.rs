//! The desktop shell.
//!
//! It owns no product logic. The dashboard, the API and every provider adapter live in
//! the Bun server, which ships here as a sidecar executable produced by
//! `bun build --compile`. This crate does four things the browser build cannot:
//!
//!   1. starts that server and stops it again when the window closes for good,
//!   2. shows something other than a connection error while it boots,
//!   3. keeps a tray icon so the dashboard survives closing the window,
//!   4. offers start-at-login, which is the whole point of a quota monitor.
//!
//! Nothing here reaches the network. The window is pointed at loopback, and the
//! server's own Host allowlist still refuses anything that is not.

use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// The port the README, the CLI and the Windows widget all document.
const PREFERRED_PORT: u16 = 4747;

/// How long the splash screen waits before admitting the server is not coming. Cold
/// first launches are the slow case: the sidecar is a ~100 MB unsigned executable and
/// Windows Defender reads all of it before letting it run.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

const POLL_INTERVAL: Duration = Duration::from_millis(120);

/// The running server, so app exit can stop it. Without this the sidecar outlives the
/// window on Windows and the next launch finds its port taken by its own ghost.
struct Sidecar(Mutex<Option<CommandChild>>);

/// Picks the port to run the server on: the documented one when it is free, otherwise
/// whatever the OS hands out.
///
/// The bind-then-drop is a race in principle — something else can take the port in the
/// gap before the sidecar binds it. In practice the only realistic contender is a
/// second copy of this app, which the single-instance plugin already prevents. Losing
/// the race costs a failed launch, not a wrong or insecure one.
///
/// A busy 4747 usually means the user already runs `bun start`. Rather than trying to
/// adopt that server, this starts its own on another port: the two read the same local
/// files, and the dashboard passes its own origin to the widget, so both keep working.
fn claim_port() -> u16 {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)).is_ok() {
        return PREFERRED_PORT;
    }
    TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .unwrap_or(PREFERRED_PORT)
}

/// Blocks until the sidecar accepts a connection, or the timeout expires.
///
/// A TCP accept is proof enough here: this process chose the port and spawned the only
/// thing that was told to bind it.
fn wait_for_server(port: u16, timeout: Duration) -> bool {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&address, POLL_INTERVAL).is_ok() {
            return true;
        }
        thread::sleep(POLL_INTERVAL);
    }
    false
}

fn show_dashboard(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Starts the server and points the window at it once it answers.
fn start_server(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let port = claim_port();
    let (mut events, child) = app
        .shell()
        .sidecar("llm-quota-server")?
        .env("PORT", port.to_string())
        .spawn()?;

    app.state::<Sidecar>().0.lock().unwrap().replace(child);

    // The sidecar's output has to be drained even though nothing consumes it: an
    // unread pipe fills, and a full pipe blocks the writer — here, the server, mid
    // request. Its stderr is worth surfacing when a launch goes wrong.
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_shell::process::CommandEvent;
        while let Some(event) = events.recv().await {
            if let CommandEvent::Stderr(line) = event {
                eprintln!("llm-quota-server: {}", String::from_utf8_lossy(&line).trim_end());
            }
        }
    });

    let handle = app.clone();
    thread::spawn(move || {
        if !wait_for_server(port, READY_TIMEOUT) {
            eprintln!("llm-quota-desktop: the server did not answer on port {port} within {READY_TIMEOUT:?}");
            return;
        }
        // Loopback by name rather than by address: the server's Host allowlist accepts
        // both, and `localhost` is what every screenshot, bookmark and doc already says.
        let Ok(url) = format!("http://localhost:{port}/").parse() else { return };
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.navigate(url);
        }
    });

    Ok(())
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let show = MenuItem::with_id(app, "show", "Show dashboard", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LLM Quota", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &autostart, &PredefinedMenuItem::separator(app)?, &quit])?;

    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("bundled window icon").clone())
        .tooltip("LLM Quota")
        .menu(&menu)
        // Left click belongs to the window, not the menu: the common action is "show me
        // the dashboard", and making that a two-step menu interaction is a tax on it.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_dashboard(app),
            "autostart" => {
                let manager = app.autolaunch();
                let enabled = manager.is_enabled().unwrap_or(false);
                let result = if enabled { manager.disable() } else { manager.enable() };
                if let Err(error) = result {
                    eprintln!("llm-quota-desktop: could not change the start-at-login setting: {error}");
                }
            }
            // Quit is the only path that stops the server; closing the window does not.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_dashboard(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // A second launch must not start a second server. Focus what is already running.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_dashboard(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let handle = app.handle();

            // Neither step is allowed to take the app down, and both used to. A tray
            // is unavailable on more Linux desktops than not, and a sidecar that will
            // not spawn still leaves a window that can say so — panicking in setup
            // gives the user a dialog with an OS error number and nothing else.
            if let Err(error) = build_tray(handle) {
                eprintln!("llm-quota-desktop: no tray icon: {error}");
            }
            if let Err(error) = start_server(handle) {
                eprintln!("llm-quota-desktop: could not start the server: {error}");
            }

            // Closing the window hides it. A quota monitor that has to be relaunched to
            // answer "am I back yet?" is a quota monitor nobody keeps running; Quit in
            // the tray is the deliberate way out.
            if let Some(window) = app.get_webview_window("main") {
                let hidden = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = hidden.hide();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to start the LLM Quota desktop shell")
        .run(|app, event| {
            // Exit only. ExitRequested is cancellable, and killing the server on an
            // exit that is then vetoed would leave a live window with no backend.
            if let RunEvent::Exit = event {
                if let Some(child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
