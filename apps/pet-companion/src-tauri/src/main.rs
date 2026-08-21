#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{WebviewWindowBuilder, WebviewUrl};

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_notification::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .setup(|app| {
      let window = WebviewWindowBuilder::new(app, "pet", WebviewUrl::default())
        .title("DSH Pet")
        .inner_size(280.0, 330.0)
        .min_inner_size(280.0, 330.0)
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .build()?;
      window.set_ignore_cursor_events(false)?;
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running DSH Pet")
}
