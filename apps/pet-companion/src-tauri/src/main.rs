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
    thread,
    time::Duration,
};
use tauri::{path::BaseDirectory, Manager, WebviewUrl, WebviewWindowBuilder};

const PLUGIN_VERSION: &str = "0.2.6";
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
    runtime_bin: Option<PathBuf>,
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
            runtime_bin: None,
        }
    }

    fn command(&self) -> Command {
        let mut command = command_for(&self.executable);
        command.args(&self.prefix_args);
        command.envs(self.environment.iter().cloned());
        if let Some(runtime_bin) = self.runtime_bin.as_deref().filter(|path| path.is_dir()) {
            let inherited = env::var_os("PATH").unwrap_or_default();
            let paths = std::iter::once(runtime_bin.to_path_buf())
                .chain(env::split_paths(&inherited));
            if let Ok(path) = env::join_paths(paths) {
                command.env("PATH", path);
            }
        }
        command
    }
}

#[derive(Deserialize)]
struct DesktopProfileState {
    active: String,
    pending: Option<String>,
}

#[derive(Deserialize)]
struct PluginPackageState {
    version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PnpmModulesState {
    store_dir: PathBuf,
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

fn installed_plugin_version(launcher: &DshLauncher) -> Option<String> {
    let dsh_home = launcher
        .environment
        .iter()
        .find(|(key, _)| key == "DSH_HOME")
        .map(|(_, value)| PathBuf::from(value))
        .or_else(|| home_dir().map(|home| desktop_home(&home)))?;
    let manifest = dsh_home
        .join("profiles")
        .join(&launcher.profile)
        .join("node_modules")
        .join(PLUGIN_NAME)
        .join("package.json");
    fs::read_to_string(manifest)
        .ok()
        .and_then(|text| serde_json::from_str::<PluginPackageState>(&text).ok())
        .map(|package| package.version)
}

fn profile_pnpm_store(dsh_home: &Path, profile: &str) -> PathBuf {
    let profile_dir = dsh_home.join("profiles").join(profile);
    let modules_state = profile_dir.join("node_modules/.modules.yaml");
    let existing = fs::read_to_string(modules_state)
        .ok()
        .and_then(|text| serde_json::from_str::<PnpmModulesState>(&text).ok())
        .map(|state| state.store_dir);
    existing
        .and_then(|store| {
            let version_dir = store
                .file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.strip_prefix('v')
                        .is_some_and(|version| version.chars().all(|character| character.is_ascii_digit()))
                });
            if version_dir {
                store.parent().map(Path::to_path_buf)
            } else {
                Some(store)
            }
        })
        .unwrap_or_else(|| profile_dir.join(".pnpm-store"))
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
    let runtime_bin = user_data.join("runtime-commands/bin");
    let profile = desktop_profile(&user_data);
    let dsh_home = desktop_home(home);
    let pnpm_store = profile_pnpm_store(&dsh_home, &profile);
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
                dsh_home.into_os_string(),
            ),
            (
                OsString::from("PNPM_CONFIG_STORE_DIR"),
                pnpm_store.into_os_string(),
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
        runtime_bin: Some(runtime_bin),
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
    let runtime_bin = user_data.join("runtime-commands/bin");
    let dsh_home = desktop_home(home);
    let pnpm_store = profile_pnpm_store(&dsh_home, &profile);
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
                dsh_home.into_os_string(),
            ),
            (
                OsString::from("PNPM_CONFIG_STORE_DIR"),
                pnpm_store.into_os_string(),
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
        runtime_bin: Some(runtime_bin),
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

fn runtime_pnpm_is_ready(launcher: &DshLauncher) -> bool {
    let Some(runtime_bin) = launcher.runtime_bin.as_deref() else {
        return true;
    };
    runtime_bin
        .join(if cfg!(windows) { "pnpm.cmd" } else { "pnpm" })
        .is_file()
}

fn launch_desktop_app(path: &Path) -> io::Result<()> {
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(path);
        command
    };
    #[cfg(not(target_os = "macos"))]
    let mut command = command_for(path);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
}

fn ensure_desktop_runtime(launcher: &DshLauncher) -> io::Result<()> {
    let Some(desktop_app) = launcher.desktop_app.as_deref() else {
        return Ok(());
    };
    if runtime_pnpm_is_ready(launcher) {
        return Ok(());
    }
    launch_desktop_app(desktop_app)?;
    for _ in 0..40 {
        if runtime_pnpm_is_ready(launcher) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "DSH Desktop did not prepare its packaged pnpm runtime",
    ))
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
    if let Err(error) = ensure_desktop_runtime(&dsh) {
        return BootstrapReport::failed(
            "DSH 内置安装器尚未准备好，请先打开一次 DSH Desktop 后重试。",
            Some(dsh_path),
            error.to_string(),
        );
    }
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

    // Adopt a manually installed plugin only when it is the bundled version.
    // Older companions used only a marker/config check, which prevented bridge
    // fixes from reaching profiles that already contained the plugin name.
    let installed_version = installed_plugin_version(&dsh);
    let needs_install = !config_has_plugin || installed_version.as_deref() != Some(PLUGIN_VERSION);

    if needs_install {
        if let Err(error) = fs::create_dir_all(&app_data) {
            return BootstrapReport::failed(
                "无法创建桌宠数据目录。",
                Some(dsh_path),
                error.to_string(),
            );
        }
        let archive = plugin_archive.to_string_lossy();
        let offline_output = match run_dsh(
            &dsh,
            &[
                "plugin",
                "--profile",
                dsh.profile.as_str(),
                "add",
                "--offline",
                "--ignore-scripts",
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
        let output = if offline_output.status.success() {
            offline_output
        } else if dsh.recovery_state.as_deref().is_some_and(Path::is_file) {
            offline_output
        } else {
            match run_dsh(
                &dsh,
                &[
                    "plugin",
                    "--profile",
                    dsh.profile.as_str(),
                    "add",
                    "--ignore-scripts",
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
            }
        };
        if !output.status.success() {
            let detail = output_detail(&output);
            let message = if detail.contains("pnpm not found") {
                "没有找到 DSH 内置安装器，请先打开一次 DSH Desktop 后重试。"
            } else if detail.contains("ERR_PNPM_META_FETCH_FAIL")
                || detail.contains("ENOTFOUND")
            {
                "插件依赖下载失败，请检查网络后重试。"
            } else {
                "桌宠插件自动安装失败。"
            };
            return BootstrapReport::failed(
                message,
                Some(dsh_path),
                detail,
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

    if let Some(desktop_app) = &dsh.desktop_app {
        return match launch_desktop_app(desktop_app) {
            Ok(()) => BootstrapReport::new(
                "ready",
                "插件已装入当前 DSH Desktop 配置；若尚未连接，请重启一次 DSH Desktop。",
                Some(dsh_path),
            ),
            Err(error) => BootstrapReport::failed(
                "插件已安装，但无法自动启动 DSH。",
                Some(dsh_path),
                error.to_string(),
            ),
        };
    }
    let mut command = {
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
            "桌宠已就绪，正在启动 DeepSeek Harness…",
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
                .min_inner_size(182.0, 215.0)
                .max_inner_size(462.0, 545.0)
                .transparent(true)
                .decorations(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .resizable(true)
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
