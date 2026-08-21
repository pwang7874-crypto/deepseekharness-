#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    env, fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};
use tauri::{path::BaseDirectory, Manager, WebviewUrl, WebviewWindowBuilder};

const PLUGIN_VERSION: &str = "0.2.0";
const PLUGIN_NAME: &str = "dsh-pet-voice-v2";
const DSH_PROFILE: &str = "web";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapReport {
    state: &'static str,
    message: String,
    dsh_path: Option<String>,
    detail: Option<String>,
}

impl BootstrapReport {
    fn new(state: &'static str, message: impl Into<String>, dsh_path: Option<&Path>) -> Self {
        Self {
            state,
            message: message.into(),
            dsh_path: dsh_path.map(|path| path.to_string_lossy().into_owned()),
            detail: None,
        }
    }

    fn failed(
        message: impl Into<String>,
        dsh_path: Option<&Path>,
        detail: impl Into<String>,
    ) -> Self {
        Self {
            state: "failed",
            message: message.into(),
            dsh_path: dsh_path.map(|path| path.to_string_lossy().into_owned()),
            detail: Some(detail.into()),
        }
    }
}

fn home_dir() -> Option<PathBuf> {
    env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn executable_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["dsh.exe", "dsh.cmd", "dsh.bat", "dsh"]
    } else {
        &["dsh"]
    }
}

fn looks_like_dsh(path: &Path) -> bool {
    path.is_file()
        && path
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case("dsh"))
}

fn command_for(path: &Path) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        let mut command =
            if extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat") {
                let mut command = Command::new("cmd");
                command.arg("/C").arg(path);
                command
            } else {
                Command::new(path)
            };
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(path)
    }
}

fn run_dsh(path: &Path, args: &[&str]) -> io::Result<Output> {
    command_for(path).args(args).stdin(Stdio::null()).output()
}

fn is_working_dsh(path: &Path) -> bool {
    looks_like_dsh(path)
        && run_dsh(path, &["--version"]).is_ok_and(|output| output.status.success())
}

fn find_on_path() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|value| {
        env::split_paths(&value)
            .flat_map(|dir| executable_names().iter().map(move |name| dir.join(name)))
            .find(|candidate| is_working_dsh(candidate))
    })
}

fn find_in_version_managers(home: &Path) -> Option<PathBuf> {
    fs::read_dir(home.join(".nvm/versions/node"))
        .ok()?
        .filter_map(Result::ok)
        .flat_map(|entry| {
            executable_names()
                .iter()
                .map(move |name| entry.path().join("bin").join(name))
        })
        .find(|candidate| is_working_dsh(candidate))
}

fn find_dsh(explicit: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(path) = explicit.filter(|path| is_working_dsh(path)) {
        return Some(path);
    }
    if let Some(path) = env::var_os("DSH_EXECUTABLE")
        .map(PathBuf::from)
        .filter(|path| is_working_dsh(path))
    {
        return Some(path);
    }
    if let Some(path) = find_on_path() {
        return Some(path);
    }

    if let Some(home) = home_dir() {
        let candidates = vec![
            home.join(".local/bin/dsh"),
            home.join(".local/share/pnpm/dsh"),
            home.join("Library/pnpm/dsh"),
            home.join(".volta/bin/dsh"),
            home.join(".bun/bin/dsh"),
        ];
        #[cfg(windows)]
        let candidates = {
            let mut candidates = candidates;
            candidates.extend([
                home.join("AppData/Roaming/npm/dsh.cmd"),
                home.join("AppData/Local/pnpm/dsh.cmd"),
            ]);
            candidates
        };
        if let Some(path) = candidates
            .into_iter()
            .find(|candidate| is_working_dsh(candidate))
        {
            return Some(path);
        }
        if let Some(path) = find_in_version_managers(&home) {
            return Some(path);
        }
    }

    [
        PathBuf::from("/opt/homebrew/bin/dsh"),
        PathBuf::from("/usr/local/bin/dsh"),
    ]
    .into_iter()
    .find(|candidate| is_working_dsh(candidate))
}

fn bridge_port_is_open() -> bool {
    let address: SocketAddr = "127.0.0.1:3080".parse().expect("valid loopback address");
    TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
}

fn bridge_plugin_is_active() -> bool {
    let address: SocketAddr = "127.0.0.1:3080".parse().expect("valid loopback address");
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /dsh-pet/events HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = [0_u8; 256];
    let Ok(size) = stream.read(&mut response) else {
        return false;
    };
    let head = String::from_utf8_lossy(&response[..size]);
    head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.1 401")
}

fn output_detail(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    let detail = if stderr.is_empty() { stdout } else { stderr };
    detail
        .chars()
        .rev()
        .take(1200)
        .collect::<String>()
        .chars()
        .rev()
        .collect()
}

fn ensure_plugin(handle: &tauri::AppHandle, explicit: Option<PathBuf>) -> BootstrapReport {
    let Some(dsh) = find_dsh(explicit) else {
        return BootstrapReport::new(
            "missing-dsh",
            "没有找到 DeepSeek Harness，请点一下选择 DSH。",
            None,
        );
    };
    let plugin_archive = match handle
        .path()
        .resolve("dsh-pet-plugin.tgz", BaseDirectory::Resource)
    {
        Ok(path) if path.is_file() => path,
        Ok(path) => {
            return BootstrapReport::failed(
                "安装包内缺少桌宠插件。",
                Some(&dsh),
                path.display().to_string(),
            )
        }
        Err(error) => {
            return BootstrapReport::failed(
                "无法读取安装包中的桌宠插件。",
                Some(&dsh),
                error.to_string(),
            )
        }
    };
    let app_data = match handle.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            return BootstrapReport::failed("无法创建桌宠数据目录。", Some(&dsh), error.to_string())
        }
    };
    let marker = app_data.join(format!("plugin-{PLUGIN_VERSION}-installed"));
    let config_has_plugin =
        run_dsh(&dsh, &["--profile", DSH_PROFILE, "--dump-config"]).is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains(PLUGIN_NAME)
        });
    let needs_install = !marker.is_file() || !config_has_plugin;

    if needs_install {
        if let Err(error) = fs::create_dir_all(&app_data) {
            return BootstrapReport::failed(
                "无法创建桌宠数据目录。",
                Some(&dsh),
                error.to_string(),
            );
        }
        let archive = plugin_archive.to_string_lossy();
        let output = match run_dsh(
            &dsh,
            &["plugin", "--profile", DSH_PROFILE, "add", archive.as_ref()],
        ) {
            Ok(output) => output,
            Err(error) => {
                return BootstrapReport::failed(
                    "无法运行 DSH 插件安装命令。",
                    Some(&dsh),
                    error.to_string(),
                )
            }
        };
        if !output.status.success() {
            return BootstrapReport::failed(
                "桌宠插件自动安装失败。",
                Some(&dsh),
                output_detail(&output),
            );
        }
        if let Err(error) = fs::write(&marker, PLUGIN_VERSION) {
            return BootstrapReport::failed(
                "插件已安装，但无法保存安装状态。",
                Some(&dsh),
                error.to_string(),
            );
        }
    }

    if bridge_plugin_is_active() {
        return BootstrapReport::new("ready", "已连接到 DeepSeek Harness", Some(&dsh));
    }
    if bridge_port_is_open() {
        return BootstrapReport::new(
            "restart-required",
            "插件已经装好，请重启一次 DeepSeek Harness。",
            Some(&dsh),
        );
    }

    let mut command = command_for(&dsh);
    command
        .arg("web")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.spawn() {
        Ok(_) => BootstrapReport::new(
            "ready",
            "桌宠已就绪，正在启动 DeepSeek Harness…",
            Some(&dsh),
        ),
        Err(error) => BootstrapReport::failed(
            "插件已安装，但无法自动启动 DSH。",
            Some(&dsh),
            error.to_string(),
        ),
    }
}

#[tauri::command]
async fn ensure_dsh_plugin(
    handle: tauri::AppHandle,
    dsh_path: Option<String>,
) -> Result<BootstrapReport, String> {
    tauri::async_runtime::spawn_blocking(move || {
        ensure_plugin(&handle, dsh_path.map(PathBuf::from))
    })
    .await
    .map_err(|error| error.to_string())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![ensure_dsh_plugin])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_nonexistent_executable_names() {
        assert!(!looks_like_dsh(Path::new("/not/a/real/dsh")));
        assert!(!looks_like_dsh(Path::new("/not/a/real/something-else")));
    }
}
