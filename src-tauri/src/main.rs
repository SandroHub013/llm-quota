// Release builds attach no console: this is a tray application, and a Windows
// console flashing up behind the window on every launch reads as a crash.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    llm_quota_desktop_lib::run()
}
