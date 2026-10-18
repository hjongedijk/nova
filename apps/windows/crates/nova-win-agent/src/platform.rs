//! Local OS actions. No command interpreter and no arbitrary command endpoint.
use nova_win_core::agent::AppEntry;
use std::collections::BTreeMap;

pub fn running_apps(apps: &BTreeMap<String, AppEntry>) -> Vec<String> {
    let system = sysinfo::System::new_all();
    apps.iter()
        .filter(|(_, app)| {
            app.process.as_ref().is_some_and(|name| {
                system.processes().values().any(|p| {
                    p.name()
                        .to_string_lossy()
                        .trim_end_matches(".exe")
                        .eq_ignore_ascii_case(name)
                })
            })
        })
        .map(|(name, _)| name.clone())
        .collect()
}

#[cfg(windows)]
pub fn open(path: &str) -> Result<(), String> {
    use windows::{
        core::PCWSTR,
        Win32::UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
    };
    let target: Vec<u16> = path.encode_utf16().chain(Some(0)).collect();
    let result = unsafe {
        ShellExecuteW(
            None,
            windows::core::w!("open"),
            PCWSTR(target.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        )
    };
    if result.0 as isize <= 32 {
        Err("Windows kon het programma of adres niet openen".into())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
pub fn lock() -> Result<(), String> {
    unsafe { windows::Win32::System::Shutdown::LockWorkStation() }.map_err(|e| e.to_string())
}

#[cfg(windows)]
pub fn close_app(name: &str) -> Result<usize, String> {
    use windows::core::BOOL;
    use windows::Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::WindowsAndMessaging::{EnumWindows, GetWindowThreadProcessId, PostMessageW, WM_CLOSE},
    };
    struct Closing {
        pids: Vec<u32>,
        windows: usize,
    }
    unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
        let closing = &mut *(data.0 as *mut Closing);
        let mut pid = 0;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        if closing.pids.contains(&pid) && PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0)).is_ok() {
            closing.windows += 1;
        }
        BOOL(1)
    }
    let system = sysinfo::System::new_all();
    let mut closing = Closing {
        pids: system
            .processes()
            .iter()
            .filter(|(_, p)| {
                p.name()
                    .to_string_lossy()
                    .trim_end_matches(".exe")
                    .eq_ignore_ascii_case(name)
            })
            .map(|(pid, _)| pid.as_u32())
            .collect(),
        windows: 0,
    };
    unsafe { EnumWindows(Some(visit), LPARAM(&mut closing as *mut Closing as isize)) }.map_err(|e| e.to_string())?;
    Ok(closing.windows)
}

#[cfg(not(windows))]
pub fn open(_: &str) -> Result<(), String> {
    Err("Alleen beschikbaar op Windows".into())
}
#[cfg(not(windows))]
pub fn lock() -> Result<(), String> {
    Err("Alleen beschikbaar op Windows".into())
}
#[cfg(not(windows))]
pub fn close_app(_: &str) -> Result<usize, String> {
    Err("Alleen beschikbaar op Windows".into())
}

#[cfg(windows)]
fn system_command(name: &str) -> std::process::Command {
    use std::os::windows::process::CommandExt;
    let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
    let mut command = std::process::Command::new(std::path::PathBuf::from(root).join("System32").join(name));
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

#[cfg(windows)]
pub fn protect_config_dir(dir: &std::path::Path) -> Result<(), String> {
    let user = format!(
        "{}\\{}",
        std::env::var("USERDOMAIN").map_err(|e| e.to_string())?,
        std::env::var("USERNAME").map_err(|e| e.to_string())?
    );
    let result = system_command("icacls.exe")
        .arg(dir)
        .args([
            "/inheritance:r",
            "/grant:r",
            &format!("{user}:(OI)(CI)F"),
            "*S-1-5-18:(OI)(CI)F",
            "*S-1-5-32-544:(OI)(CI)F",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        Ok(())
    } else {
        Err("Kan de toegang tot de lokale NOVA-configuratie niet beperken".into())
    }
}

/// Called only by the elevated copy of this same executable. All arguments are validated before spawning.
#[cfg(windows)]
pub fn configure_network(port: u16, source: &str) -> Result<(), String> {
    source
        .parse::<std::net::IpAddr>()
        .map_err(|_| "Ongeldig NOVA-serveradres")?;
    let _ = system_command("netsh.exe")
        .args(["advfirewall", "firewall", "delete", "rule", "name=NOVA native agent"])
        .output();
    let result = system_command("netsh.exe")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            "name=NOVA native agent",
            "dir=in",
            "action=allow",
            "protocol=TCP",
            &format!("localport={port}"),
            &format!("remoteip={source}"),
            "profile=private,domain",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        for name in ["NOVA Windows agent", "Jarvis Windows agent"] {
            let _ = system_command("netsh.exe")
                .args(["advfirewall", "firewall", "delete", "rule", &format!("name={name}")])
                .output();
        }
        Ok(())
    } else {
        Err("Windows kon de firewallregel niet toevoegen".into())
    }
}

#[cfg(windows)]
pub fn request_network(port: u16, source: &str) -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::CloseHandle,
            System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
            UI::{
                Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
                WindowsAndMessaging::SW_HIDE,
            },
        },
    };
    source
        .parse::<std::net::IpAddr>()
        .map_err(|_| "Ongeldig NOVA-serveradres")?;
    let exe: Vec<u16> = std::env::current_exe()
        .map_err(|e| e.to_string())?
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let parameters: Vec<u16> = format!("--configure-network {port} {source}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(exe.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_HIDE.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info).map_err(|e| e.to_string())?;
        WaitForSingleObject(info.hProcess, INFINITE);
        let mut exit = 1;
        let read = GetExitCodeProcess(info.hProcess, &mut exit);
        let _ = CloseHandle(info.hProcess);
        read.map_err(|e| e.to_string())?;
        if exit != 0 {
            return Err("Firewall instellen mislukt".into());
        }
    }
    Ok(())
}

/// Ends only the two documented legacy tasks and PowerShell agents from the selected folder.
#[cfg(windows)]
pub fn retire_legacy(dir: &std::path::Path) -> Result<(), String> {
    let system = sysinfo::System::new_all();
    let files: Vec<_> = ["nova-agent.ps1", "jarvis-agent.ps1"]
        .iter()
        .map(|n| dir.join(n).to_string_lossy().to_lowercase())
        .collect();
    for p in system.processes().values() {
        let name = p.name().to_string_lossy().to_lowercase();
        if matches!(name.as_str(), "powershell.exe" | "pwsh.exe")
            && p.cmd()
                .iter()
                .any(|arg| files.contains(&arg.to_string_lossy().trim_matches('"').to_lowercase()))
        {
            if !p.kill() {
                return Err("De oude agent kon niet worden gestopt".into());
            }
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            let mut remaining = sysinfo::System::new();
            loop {
                remaining.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[p.pid()]), true);
                if !remaining
                    .process(p.pid())
                    .is_some_and(|old| old.start_time() == p.start_time())
                {
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err("De oude agent sluit niet op tijd af".into());
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
    for task in ["NOVAAgent", "JarvisAgent"] {
        // A missing task is harmless. Removing the registration never removes the old files.
        let _ = system_command("schtasks.exe").args(["/End", "/TN", task]).output();
        let exists = system_command("schtasks.exe")
            .args(["/Query", "/TN", task])
            .output()
            .map_err(|e| e.to_string())?
            .status
            .success();
        if exists
            && !system_command("schtasks.exe")
                .args(["/Delete", "/TN", task, "/F"])
                .output()
                .map_err(|e| e.to_string())?
                .status
                .success()
        {
            return Err(format!("Taak {task} kon niet worden verwijderd. Verwijder deze taak in Windows Taakplanner en probeer opnieuw."));
        }
    }
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(nova_win_core::autostart::RUN_KEY, winreg::enums::KEY_SET_VALUE)
    {
        let _ = key.delete_value("NOVA Desk");
    }
    // Ask the old native shell to exit through its existing single-instance protocol.
    let old = dir.join("nova-desk.exe");
    if old.is_file() {
        let _ = std::process::Command::new(old).arg("--quit").spawn();
    }
    Ok(())
}

#[cfg(windows)]
pub fn show_error(message: &str) {
    use windows::{
        core::{w, PCWSTR},
        Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK},
    };
    let text: Vec<u16> = message.encode_utf16().chain(Some(0)).collect();
    unsafe {
        MessageBoxW(None, PCWSTR(text.as_ptr()), w!("NOVA"), MB_OK | MB_ICONERROR);
    }
}

#[cfg(not(windows))]
pub fn protect_config_dir(_: &std::path::Path) -> Result<(), String> {
    Ok(())
}
#[cfg(not(windows))]
pub fn request_network(_: u16, _: &str) -> Result<(), String> {
    Err("Alleen beschikbaar op Windows".into())
}
#[cfg(not(windows))]
pub fn retire_legacy(_: &std::path::Path) -> Result<(), String> {
    Err("Alleen beschikbaar op Windows".into())
}
#[cfg(not(windows))]
pub fn show_error(message: &str) {
    eprintln!("{message}");
}

#[cfg(windows)]
pub fn show_desktop() {
    use windows::Win32::UI::Input::KeyboardAndMouse::*;
    let keys = [
        (VK_LWIN, KEYBD_EVENT_FLAGS(0)),
        (VIRTUAL_KEY(0x44), KEYBD_EVENT_FLAGS(0)),
        (VIRTUAL_KEY(0x44), KEYEVENTF_KEYUP),
        (VK_LWIN, KEYEVENTF_KEYUP),
    ];
    let inputs: Vec<INPUT> = keys
        .into_iter()
        .map(|(w_vk, dw_flags)| INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: w_vk,
                    dwFlags: dw_flags,
                    ..Default::default()
                },
            },
        })
        .collect();
    unsafe {
        SendInput(&inputs, std::mem::size_of::<INPUT>() as i32);
    }
}
#[cfg(not(windows))]
pub fn show_desktop() {}

/// The filtered administrator token is false until the user approves a UAC elevation.
#[cfg(windows)]
pub fn is_elevated() -> bool {
    unsafe { windows::Win32::UI::Shell::IsUserAnAdmin().as_bool() }
}
#[cfg(not(windows))]
pub fn is_elevated() -> bool {
    false
}

/// The elevated successor waits for this process to release Tauri's single-instance lock.
#[cfg(windows)]
pub fn request_elevation(parent: u32) -> Result<(), String> {
    use windows::{
        core::{w, PCWSTR},
        Win32::{
            Foundation::CloseHandle,
            UI::{
                Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW},
                WindowsAndMessaging::SW_SHOWNORMAL,
            },
        },
    };
    if !can_elevate_same_user() {
        return Err("Gebruik voor deze instelling een Windows-account met beheerdersrechten. Een ander beheerdersaccount heeft een eigen NOVA-configuratie.".into());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let file: Vec<u16> = exe
        .as_os_str()
        .to_string_lossy()
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let args: Vec<u16> = format!("--wait-for-pid {parent}")
        .encode_utf16()
        .chain(Some(0))
        .collect();
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOCLOSEPROCESS,
        lpVerb: w!("runas"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(args.as_ptr()),
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe {
        ShellExecuteExW(&mut info)
            .map_err(|_| "Beheerrechten niet verleend. NOVA blijft zonder beheerrechten actief.".to_string())?;
        if !info.hProcess.is_invalid() {
            let _ = CloseHandle(info.hProcess);
        }
    }
    Ok(())
}
#[cfg(windows)]
fn can_elevate_same_user() -> bool {
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        Security::{
            GetTokenInformation, TokenElevationType, TokenElevationTypeLimited, TOKEN_ELEVATION_TYPE, TOKEN_QUERY,
        },
        System::Threading::{GetCurrentProcess, OpenProcessToken},
    };
    if is_elevated() {
        return true;
    }
    let mut token = HANDLE::default();
    unsafe {
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return false;
        }
        let mut kind = TOKEN_ELEVATION_TYPE::default();
        let mut length = 0;
        let result = GetTokenInformation(
            token,
            TokenElevationType,
            Some((&mut kind as *mut TOKEN_ELEVATION_TYPE).cast()),
            std::mem::size_of::<TOKEN_ELEVATION_TYPE>() as u32,
            &mut length,
        );
        let _ = CloseHandle(token);
        result.is_ok() && kind == TokenElevationTypeLimited
    }
}
#[cfg(not(windows))]
pub fn request_elevation(_: u32) -> Result<(), String> {
    Err("Alleen beschikbaar op Windows".into())
}
#[cfg(windows)]
pub fn wait_for_parent(pid: u32) -> Result<(), String> {
    use windows::Win32::{
        Foundation::{CloseHandle, WAIT_TIMEOUT},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };
    if pid == 0 || pid == std::process::id() {
        return Err("Ongeldig vorig proces".into());
    }
    if let Ok(handle) = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) } {
        let result = unsafe { WaitForSingleObject(handle, 15_000) };
        unsafe {
            let _ = CloseHandle(handle);
        }
        if result == WAIT_TIMEOUT {
            return Err("De vorige NOVA-app sluit niet op tijd af".into());
        }
    }
    Ok(())
}
