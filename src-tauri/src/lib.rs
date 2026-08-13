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
use tauri::{AppHandle, LogicalSize, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
#[cfg(target_os = "linux")]
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// The port the README, the CLI and the Windows widget all document.
const PREFERRED_PORT: u16 = 4747;

/// How long the splash screen waits before admitting the server is not coming. Cold
/// first launches are the slow case: the sidecar is a ~100 MB unsigned executable and
/// Windows Defender reads all of it before letting it run.
const READY_TIMEOUT: Duration = Duration::from_secs(30);

const POLL_INTERVAL: Duration = Duration::from_millis(120);

/// The viewport the dashboard is laid out for.
///
/// Width: below 1240 CSS pixels the card flow drops from four columns to two, so the
/// window has to clear that or the desktop app shows a different layout from a
/// maximised browser.
///
/// Height: deliberately under the 850 the `main .gh-prototype { column-span: all }`
/// rule keys on. Above it the token ledger becomes a full-width band beneath the
/// provider columns; below it the ledger stays a fourth card in the flow, which is
/// what a browser shows — a tab strip and an address bar cost roughly the 60 pixels
/// that put a maximised browser on the short side of that threshold, and a window
/// with no chrome does not. Matching the browser matters more here than filling the
/// screen: the two layouts are both intended, but only one of them is the one users
/// have already learned.
const DESIGN_WIDTH: f64 = 1280.0;
const DESIGN_HEIGHT: f64 = 830.0;

/// Sizes the window so the webview gets [`DESIGN_WIDTH`] CSS pixels, never more than
/// the screen can hold.
///
/// The size in tauri.conf.json is applied before the window knows which monitor it
/// landed on, so on a display with OS scaling it produced a webview of
/// `1280 / scale` CSS pixels — 1024 at the 125% Windows ships as default on many
/// laptops. The dashboard then rendered as if in a small window: wrapped titles, a
/// clipped horizon, and the usage and live badges pushed out of the header. Setting a
/// LogicalSize here is the fix, because logical pixels are the CSS pixels the page
/// actually gets, whatever the scale factor is.
fn fit_to_design(window: &WebviewWindow) {
    let scale = window.scale_factor().unwrap_or(1.0);

    let monitor = window.current_monitor().ok().flatten().map(|monitor| {
        let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
        (size.width, size.height)
    });

    let (width, height) = design_size(monitor);

    if let Err(error) = window.set_size(LogicalSize::new(width, height)) {
        eprintln!("llm-quota-desktop: could not size the window: {error}");
        return;
    }
    let _ = window.center();

    if width < DESIGN_WIDTH {
        eprintln!(
            "llm-quota-desktop: the screen is {width:.0} logical pixels wide at {scale}× scaling, \
             narrower than the {DESIGN_WIDTH:.0} the dashboard is laid out for"
        );
    }
}

/// The design viewport, clamped to what a monitor of this logical size can hold.
///
/// Split out of [`fit_to_design`] because the clamp is the part that can be wrong and
/// the window it sets is the part that cannot be built in a test. The margins leave the
/// work area room: a window sized exactly to the monitor sits under the taskbar on
/// Windows and behind the menu bar on macOS. A monitor the shell cannot identify is
/// treated as large enough, which is the same assumption the config file makes.
fn design_size(monitor: Option<(f64, f64)>) -> (f64, f64) {
    let (max_width, max_height) = monitor
        .map(|(width, height)| (width - 48.0, height - 96.0))
        .unwrap_or((DESIGN_WIDTH, DESIGN_HEIGHT));

    (DESIGN_WIDTH.min(max_width), DESIGN_HEIGHT.min(max_height))
}

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

/// Whether a check with nothing to report is allowed to stay silent.
///
/// A check the user asked for has to answer either way — a menu item that does nothing
/// visible reads as broken. The one at startup keeps quiet unless there is an update,
/// because a dialog on every launch saying "no news" is a dialog people learn to close
/// without reading, including the launch that did have news.
#[derive(Clone, Copy, PartialEq)]
enum Announce {
    OnlyWhenNewer,
    Always,
}

/// Where a release the updater cannot install itself can be fetched by hand.
const RELEASES_URL: &str = "https://github.com/SandroHub013/llm-quota/releases/latest";

/// Linux installs from a deb, and the updater replaces AppImages. Rather than offer an
/// update it cannot carry out, it points at the release and lets the package manager
/// stay the thing that owns the files it installed.
#[cfg(target_os = "linux")]
fn offer_update(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "LLM Quota {} is available. This copy was installed from a package, so the \
             update is a download rather than something this window can apply.",
            update.version
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Open the release".to_owned(),
            "Not now".to_owned(),
        ))
        .show(move |open| {
            if open {
                if let Err(error) = handle.opener().open_url(RELEASES_URL, None::<&str>) {
                    eprintln!("llm-quota-desktop: could not open the release page: {error}");
                }
            }
        });
}

/// Windows and macOS: the updater can replace the installed app, so the dialog offers
/// to do it. Downloading happens after the answer, never before — an update nobody
/// agreed to should not be spending someone's connection in the background.
#[cfg(not(target_os = "linux"))]
fn offer_update(app: &AppHandle, update: tauri_plugin_updater::Update) {
    let handle = app.clone();
    app.dialog()
        .message(format!(
            "LLM Quota {} is available. Installing it restarts the app; the server it \
             runs stops with it and comes back on the other side.",
            update.version
        ))
        .title("Update available")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Update now".to_owned(),
            "Not now".to_owned(),
        ))
        .show(move |accepted| {
            if !accepted {
                return;
            }
            let handle = handle.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = update.download_and_install(|_, _| {}, || {}).await {
                    eprintln!("llm-quota-desktop: the update did not install: {error}");
                    handle
                        .dialog()
                        .message(format!(
                            "The update could not be installed: {error}\n\nIt can be \
                             downloaded by hand from {RELEASES_URL}"
                        ))
                        .title("Update failed")
                        .show(|_| {});
                    return;
                }
                // The installer has replaced the app on disk; this process is still the
                // old one, and the sidecar it owns still holds the port.
                handle.restart();
            });
        });
}

/// Asks the release feed whether there is anything newer, and offers what it finds.
///
/// Failures here are reported to the console and nowhere else on the automatic check:
/// a machine that is offline, or behind a proxy that eats the request, is not having a
/// problem the user opened this app to hear about.
fn check_for_updates(app: &AppHandle, announce: Announce) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match handle.updater() {
            Ok(updater) => updater,
            Err(error) => {
                eprintln!("llm-quota-desktop: no updater: {error}");
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => offer_update(&handle, update),
            Ok(None) => {
                if announce == Announce::Always {
                    handle
                        .dialog()
                        .message(format!("LLM Quota {} is the latest release.", env!("CARGO_PKG_VERSION")))
                        .title("No update available")
                        .show(|_| {});
                }
            }
            Err(error) => {
                eprintln!("llm-quota-desktop: could not check for updates: {error}");
                if announce == Announce::Always {
                    handle
                        .dialog()
                        .message(format!("Could not check for updates: {error}"))
                        .title("Update check failed")
                        .show(|_| {});
                }
            }
        }
    });
}

fn build_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);

    let show = MenuItem::with_id(app, "show", "Show dashboard", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(app, "autostart", "Start at login", true, autostart_on, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "Check for updates…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LLM Quota", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show, &autostart, &update, &PredefinedMenuItem::separator(app)?, &quit],
    )?;

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
            // Asked for by hand, so silence would read as a broken menu item: this one
            // says so when there is nothing to install.
            "update" => check_for_updates(app, Announce::Always),
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

/// Turns off WebKitGTK's DMA-BUF renderer, which does not draw this app correctly on
/// a large number of Linux desktops.
///
/// The symptom is specific and recognisable: cards are not painted at all until the
/// pointer moves over them, and what appears then is torn or half-drawn. Nothing is
/// wrong with the page — the compositor simply never hands over what was rendered, so
/// only the regions an input event invalidates ever reach the screen. It shows up most
/// on GNOME under Wayland and on NVIDIA's driver, which together are a large share of
/// the Linux desktops this will land on.
///
/// The cost is a slower path for compositing, on a window that shows a dashboard
/// refreshing every few seconds rather than anything animating at speed. A window that
/// draws correctly and slowly beats one that draws quickly and wrong.
///
/// Set before the webview exists, because it is read when WebKitGTK initialises.
#[cfg(target_os = "linux")]
fn work_around_webkit_rendering() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
}

#[cfg(not(target_os = "linux"))]
fn work_around_webkit_rendering() {}

pub fn run() {
    work_around_webkit_rendering();

    tauri::Builder::default()
        // A second launch must not start a second server. Focus what is already running.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_dashboard(app);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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

            // A quota monitor is left running for weeks, so it cannot rely on being
            // relaunched to notice a release. This asks once per launch and says
            // nothing unless there is something to say.
            check_for_updates(handle, Announce::OnlyWhenNewer);

            // Closing the window hides it. A quota monitor that has to be relaunched to
            // answer "am I back yet?" is a quota monitor nobody keeps running; Quit in
            // the tray is the deliberate way out.
            if let Some(window) = app.get_webview_window("main") {
                fit_to_design(&window);

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

#[cfg(test)]
mod tests {
    use super::*;

    /// A laptop at 1920×1080 has room to spare, so the dashboard gets the viewport it
    /// is laid out for rather than the screen it landed on.
    #[test]
    fn a_large_monitor_gets_the_design_viewport() {
        assert_eq!(design_size(Some((1920.0, 1080.0))), (DESIGN_WIDTH, DESIGN_HEIGHT));
    }

    /// The case the margins exist for. A window sized to the full work area sits under
    /// the taskbar, so both axes clamp and neither is allowed to exceed the screen.
    #[test]
    fn a_small_monitor_clamps_both_axes_with_room_left() {
        let (width, height) = design_size(Some((1024.0, 600.0)));

        assert_eq!((width, height), (976.0, 504.0));
        assert!(width < 1024.0 && height < 600.0);
    }

    /// Only one axis is short on a wide, shallow screen, and the other must not shrink
    /// with it — the height threshold is what decides the token ledger's layout.
    #[test]
    fn a_short_monitor_clamps_only_the_height() {
        assert_eq!(design_size(Some((2560.0, 800.0))), (DESIGN_WIDTH, 704.0));
    }

    /// A monitor the shell cannot identify is not a reason to open a window of zero
    /// size, or of some fraction of a size nobody measured.
    #[test]
    fn an_unknown_monitor_falls_back_to_the_design_viewport() {
        assert_eq!(design_size(None), (DESIGN_WIDTH, DESIGN_HEIGHT));
    }

    /// 4747 is what the README, the CLI and the widget all name, so it is taken when it
    /// can be and never silently shared when it cannot.
    #[test]
    fn a_busy_preferred_port_falls_back_to_a_free_one() {
        let Ok(held) = TcpListener::bind((Ipv4Addr::LOCALHOST, PREFERRED_PORT)) else {
            // Something outside this test already holds it; the fallback is then what
            // claim_port returns anyway, and asserting on a port we do not control
            // would be asserting on the machine.
            return;
        };

        let port = claim_port();
        assert_ne!(port, PREFERRED_PORT, "the port was already held");
        assert_ne!(port, 0, "0 asks the OS to choose again at bind time");

        // Free, or the sidecar is about to be told to bind something it cannot have.
        assert!(TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok());
        drop(held);
    }

    /// The splash screen waits on this. Returning true for a port nothing is listening
    /// on would point the window at a server that does not exist.
    #[test]
    fn waiting_gives_up_on_a_port_with_no_listener() {
        let port = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .and_then(|listener| listener.local_addr())
            .map(|address| address.port())
            .expect("the OS should hand out an ephemeral port");

        assert!(!wait_for_server(port, Duration::from_millis(300)));
    }

    /// And the other half: a listener that accepts is the signal to navigate.
    #[test]
    fn waiting_returns_as_soon_as_something_accepts() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).expect("bind");
        let port = listener.local_addr().expect("addr").port();

        assert!(wait_for_server(port, Duration::from_secs(5)));
    }
}
