#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    env,
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};
use tauri::{path::BaseDirectory, Manager, WebviewUrl, WebviewWindowBuilder};

const PLUGIN_VERSION: &str = "0.2.0";
const PLUGIN_NAME: &str = "dsh-pet-voice-v2";
const CLI_PROFILE: &str = "web";
const DESKTOP_PROFILE: &str = "desktop";

#[derive(Clone, Debug)]
struct DshLauncher {
    executable: PathBuf,
    prefix_args: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    display_path: PathBuf,
    profile: String,
    desktop_app: Option<PathBuf>,
    recovery_state: Option<PathBuf>,
}

impl DshLauncher {
    fn cli(path: PathBuf) -> Self {
        Self {
            executable: path.clone(),
            prefix_args: Vec::new(),
            environment: Vec::new(),
            display_path: path,
            profile: CLI_PROFILE.to_owned(),
            desktop_app: None,
            recovery_state: None,
        }
    }

    fn command(&self) -> Command {
        let mut command = command_for(&self.executable);
        command.args(&self.prefix_args);
        command.envs(self.environment.iter().cloned());
        command
    }
}

#[derive(Deserialize)]
struct DesktopProfileState {
    active: String,
    pending: Option<String>,
}

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

fn desktop_profile(user_data: &Path) -> String {
    let state_path = user_data.join("profile-selection/state.json");
    fs::read_to_string(state_path)
        .ok()
        .and_then(|text| serde_json::from_str::<DesktopProfileState>(&text).ok())
        .map(|state| state.pending.unwrap_or(state.active))
        .filter(|name| {
            !name.is_empty()
                && name.len() <= 255
                && !name.chars().any(char::is_control)
                && !name.contains('/')
                && !name.contains('\\')
        })
        .unwrap_or_else(|| DESKTOP_PROFILE.to_owned())
}

fn desktop_home(home: &Path) -> PathBuf {
    env::var_os("DSH_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".dsh"))
}

#[cfg(target_os = "macos")]
fn desktop_launcher_from_path(path: &Path, home: &Path) -> Option<DshLauncher> {
    let app = if path.extension().and_then(|value| value.to_str()) == Some("app") {
        path.to_path_buf()
    } else if path.file_name().and_then(|value| value.to_str()) == Some("DSH Desktop") {
        path.ancestors().nth(3)?.to_path_buf()
    } else if path.is_dir() {
        path.join("DSH Desktop.app")
    } else {
        return None;
    };
    let executable = app.join("Contents/MacOS/DSH Desktop");
    let bootstrap = app.join("Contents/Resources/app.asar.unpacked/lib/desktop-cli.js");
    if !app.is_dir() || !executable.is_file() || !bootstrap.is_file() {
        return None;
    }
    let user_data = home.join("Library/Application Support/DSH Desktop");
    let recovery_state = user_data.join("plugin-install-recovery/state.json");
    let profile = desktop_profile(&user_data);
    Some(DshLauncher {
        executable,
        prefix_args: vec![
            OsString::from("--expose-internals"),
            bootstrap.into_os_string(),
        ],
        environment: vec![
            (OsString::from("ELECTRON_RUN_AS_NODE"), OsString::from("1")),
            (
                OsString::from("DSH_HOME"),
                desktop_home(home).into_os_string(),
            ),
            (
                OsString::from("DSH_DESKTOP_DEFAULT_PROFILE"),
                OsString::from(&profile),
            ),
            (
                OsString::from("DSH_DESKTOP_INSTALL_RECOVERY_STATE_PATH"),
                recovery_state.clone().into_os_string(),
            ),
        ],
        display_path: app.clone(),
        profile,
        desktop_app: Some(app),
        recovery_state: Some(recovery_state),
    })
}

#[cfg(target_os = "windows")]
fn desktop_launcher_from_path(path: &Path, home: &Path) -> Option<DshLauncher> {
    let executable = if path.is_dir() {
        path.join("DSH Desktop.exe")
    } else {
        path.to_path_buf()
    };
    if !executable
        .file_name()?
        .to_str()?
        .eq_ignore_ascii_case("DSH Desktop.exe")
        || !executable.is_file()
    {
        return None;
    }
    let app_dir = executable.parent()?.to_path_buf();
    let bootstrap = app_dir.join("resources/app.asar.unpacked/lib/desktop-cli.js");
    if !bootstrap.is_file() {
        return None;
    }
    let user_data = env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join("AppData/Roaming"))
        .join("DSH Desktop");
    let profile = desktop_profile(&user_data);
    let recovery_state = user_data.join("plugin-install-recovery/state.json");
    Some(DshLauncher {
        executable: executable.clone(),
        prefix_args: vec![
            OsString::from("--expose-internals"),
            bootstrap.into_os_string(),
        ],
        environment: vec![
            (OsString::from("ELECTRON_RUN_AS_NODE"), OsString::from("1")),
            (
                OsString::from("DSH_HOME"),
                desktop_home(home).into_os_string(),
            ),
            (
                OsString::from("DSH_DESKTOP_DEFAULT_PROFILE"),
                OsString::from(&profile),
            ),
            (
                OsString::from("DSH_DESKTOP_INSTALL_RECOVERY_STATE_PATH"),
                recovery_state.clone().into_os_string(),
            ),
        ],
        display_path: executable.clone(),
        profile,
        desktop_app: Some(executable),
        recovery_state: Some(recovery_state),
    })
}

#[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
fn desktop_launcher_from_path(_path: &Path, _home: &Path) -> Option<DshLauncher> {
    None
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

fn run_dsh(launcher: &DshLauncher, args: &[&str]) -> io::Result<Output> {
    launcher.command().args(args).stdin(Stdio::null()).output()
}

fn is_working_launcher(launcher: &DshLauncher) -> bool {
    run_dsh(launcher, &["--version"]).is_ok_and(|output| output.status.success())
}

fn cli_launcher(path: &Path) -> Option<DshLauncher> {
    if !looks_like_dsh(path) {
        return None;
    }
    let launcher = DshLauncher::cli(path.to_path_buf());
    is_working_launcher(&launcher).then_some(launcher)
}

fn launcher_from_path(path: &Path, home: Option<&Path>) -> Option<DshLauncher> {
    if let Some(launcher) = cli_launcher(path) {
        return Some(launcher);
    }
    let launcher = desktop_launcher_from_path(path, home?)?;
    is_working_launcher(&launcher).then_some(launcher)
}

fn find_on_path() -> Option<DshLauncher> {
    env::var_os("PATH").and_then(|value| {
        env::split_paths(&value)
            .flat_map(|dir| executable_names().iter().map(move |name| dir.join(name)))
            .find_map(|candidate| cli_launcher(&candidate))
    })
}

fn find_in_version_managers(home: &Path) -> Option<DshLauncher> {
    fs::read_dir(home.join(".nvm/versions/node"))
        .ok()?
        .filter_map(Result::ok)
        .flat_map(|entry| {
            executable_names()
                .iter()
                .map(move |name| entry.path().join("bin").join(name))
        })
        .find_map(|candidate| cli_launcher(&candidate))
}

fn desktop_candidates(home: &Path) -> Vec<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        vec![
            PathBuf::from("/Applications/DSH Desktop.app"),
            home.join("Applications/DSH Desktop.app"),
        ]
    }
    #[cfg(target_os = "windows")]
    {
        let mut paths = Vec::new();
        if let Some(local) = env::var_os("LOCALAPPDATA") {
            paths.push(PathBuf::from(local).join("Programs/DSH Desktop/DSH Desktop.exe"));
        }
        if let Some(program_files) = env::var_os("PROGRAMFILES") {
            paths.push(PathBuf::from(program_files).join("DSH Desktop/DSH Desktop.exe"));
        }
        paths
    }
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        Vec::new()
    }
}

fn find_dsh(explicit: Option<PathBuf>) -> Option<DshLauncher> {
    let home = home_dir();
    if let Some(launcher) = explicit
        .as_deref()
        .and_then(|path| launcher_from_path(path, home.as_deref()))
    {
        return Some(launcher);
    }
    if let Some(path) = env::var_os("DSH_EXECUTABLE").map(PathBuf::from) {
        if let Some(launcher) = launcher_from_path(&path, home.as_deref()) {
            return Some(launcher);
        }
    }
    if let Some(home) = home.as_deref() {
        if let Some(launcher) = desktop_candidates(home)
            .into_iter()
            .find_map(|path| launcher_from_path(&path, Some(home)))
        {
            return Some(launcher);
        }
    }
    if let Some(launcher) = find_on_path() {
        return Some(launcher);
    }

    if let Some(home) = home {
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
        if let Some(launcher) = candidates
            .into_iter()
            .find_map(|candidate| cli_launcher(&candidate))
        {
            return Some(launcher);
        }
        if let Some(launcher) = find_in_version_managers(&home) {
            return Some(launcher);
        }
    }

    [
        PathBuf::from("/opt/homebrew/bin/dsh"),
        PathBuf::from("/usr/local/bin/dsh"),
    ]
    .into_iter()
    .find_map(|candidate| cli_launcher(&candidate))
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
            "没有找到 DSH Desktop 或 dsh 命令，请点一下选择 DSH。",
            None,
        );
    };
    let dsh_path = &dsh.display_path;
    let plugin_archive = match handle
        .path()
        .resolve("dsh-pet-plugin.tgz", BaseDirectory::Resource)
    {
        Ok(path) if path.is_file() => path,
        Ok(path) => {
            return BootstrapReport::failed(
                "安装包内缺少桌宠插件。",
                Some(dsh_path),
                path.display().to_string(),
            )
        }
        Err(error) => {
            return BootstrapReport::failed(
                "无法读取安装包中的桌宠插件。",
                Some(dsh_path),
                error.to_string(),
            )
        }
    };
    let app_data = match handle.path().app_data_dir() {
        Ok(path) => path,
        Err(error) => {
            return BootstrapReport::failed(
                "无法创建桌宠数据目录。",
                Some(dsh_path),
                error.to_string(),
            )
        }
    };
    let marker_profile = dsh
        .profile
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let marker = app_data.join(format!(
        "plugin-{PLUGIN_VERSION}-{marker_profile}-installed"
    ));
    let config_has_plugin = run_dsh(&dsh, &["--profile", dsh.profile.as_str(), "--dump-config"])
        .is_ok_and(|output| {
            output.status.success() && String::from_utf8_lossy(&output.stdout).contains(PLUGIN_NAME)
        });
    if dsh.recovery_state.as_deref().is_some_and(Path::is_file) {
        return BootstrapReport::new(
            "restart-required",
            "DSH Desktop 正在等待完成插件安装，请完全退出并重新打开一次 DSH Desktop。",
            Some(dsh_path),
        );
    }

    // A plugin may already have been installed from DSH Desktop's built-in
    // terminal or by an earlier companion build. Adopt that healthy config
    // instead of installing it again merely because our local marker is absent.
    let needs_install = !config_has_plugin;

    if needs_install {
        if let Err(error) = fs::create_dir_all(&app_data) {
            return BootstrapReport::failed(
                "无法创建桌宠数据目录。",
                Some(dsh_path),
                error.to_string(),
            );
        }
        let archive = plugin_archive.to_string_lossy();
        let output = match run_dsh(
            &dsh,
            &[
                "plugin",
                "--profile",
                dsh.profile.as_str(),
                "add",
                archive.as_ref(),
            ],
        ) {
            Ok(output) => output,
            Err(error) => {
                return BootstrapReport::failed(
                    "无法运行 DSH 插件安装命令。",
                    Some(dsh_path),
                    error.to_string(),
                )
            }
        };
        if !output.status.success() {
            return BootstrapReport::failed(
                "桌宠插件自动安装失败。",
                Some(dsh_path),
                output_detail(&output),
            );
        }
        if let Err(error) = fs::write(&marker, PLUGIN_VERSION) {
            return BootstrapReport::failed(
                "插件已安装，但无法保存安装状态。",
                Some(dsh_path),
                error.to_string(),
            );
        }
    } else if !marker.is_file() {
        if let Err(error) =
            fs::create_dir_all(&app_data).and_then(|_| fs::write(&marker, PLUGIN_VERSION))
        {
            return BootstrapReport::failed(
                "插件已安装，但无法保存安装状态。",
                Some(dsh_path),
                error.to_string(),
            );
        }
    }

    if bridge_plugin_is_active() {
        return BootstrapReport::new("ready", "已连接到 DeepSeek Harness", Some(dsh_path));
    }
    if bridge_port_is_open() {
        return BootstrapReport::new(
            "restart-required",
            "插件已经装好，请重启一次 DeepSeek Harness。",
            Some(dsh_path),
        );
    }

    let mut command = if let Some(desktop_app) = &dsh.desktop_app {
        #[cfg(target_os = "macos")]
        {
            let mut command = Command::new("open");
            command.arg(desktop_app);
            command
        }
        #[cfg(not(target_os = "macos"))]
        {
            command_for(desktop_app)
        }
    } else {
        let mut command = dsh.command();
        command.arg("web");
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match command.spawn() {
        Ok(_) => BootstrapReport::new(
            "ready",
            if dsh.desktop_app.is_some() {
                "插件已装入当前 DSH Desktop 配置；若尚未连接，请重启一次 DSH Desktop。"
            } else {
                "桌宠已就绪，正在启动 DeepSeek Harness…"
            },
            Some(dsh_path),
        ),
        Err(error) => BootstrapReport::failed(
            "插件已安装，但无法自动启动 DSH。",
            Some(dsh_path),
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

    #[test]
    fn falls_back_to_desktop_profile_for_missing_state() {
        assert_eq!(
            desktop_profile(Path::new("/not/a/real/user-data")),
            "desktop"
        );
    }
}
