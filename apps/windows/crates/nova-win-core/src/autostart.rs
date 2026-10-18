//! The value of the "start with Windows" entry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`): no
//! administrator rights, only for this user, and removed again from the tray menu.

pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
pub const RUN_VALUE_NAME: &str = "NOVA";

/// The command line for the Run key: the quoted path of the executable, nothing else (settings come from desk.json).
pub fn run_value(exe: &str) -> Option<String> {
    let exe = exe.trim();
    if exe.is_empty() || exe.contains('"') || exe.contains('\0') || exe.contains('\n') {
        return None;
    }
    Some(format!("\"{exe}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_is_quoted() {
        assert_eq!(
            run_value("C:\\Program Files\\NOVA\\nova-desk.exe").as_deref(),
            Some("\"C:\\Program Files\\NOVA\\nova-desk.exe\"")
        );
    }

    #[test]
    fn odd_paths_are_refused() {
        assert_eq!(run_value(""), None);
        assert_eq!(run_value("C:\\a\" --evil \"b.exe"), None);
        assert_eq!(run_value("C:\\a\nb.exe"), None);
    }

    #[test]
    fn the_key_is_the_current_user_run_key() {
        assert!(RUN_KEY.ends_with("CurrentVersion\\Run"));
        assert_eq!(RUN_VALUE_NAME, "NOVA");
    }
}
