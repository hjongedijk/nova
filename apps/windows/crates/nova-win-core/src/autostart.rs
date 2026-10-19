//! Same-user Windows startup: a normal Run entry or an explicitly approved elevated task.

pub const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";
pub const RUN_VALUE_NAME: &str = "NOVA";

/// The command line for the Run key: the quoted path of the executable, nothing else (settings come from config.json).
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

/// Separate task per Windows account; no password or SYSTEM identity is used.
pub fn task_name(sid: &str) -> Option<String> {
    if sid.len() > 184
        || !sid.starts_with("S-1-")
        || !sid[4..]
            .split('-')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
    {
        return None;
    }
    Some(format!("NOVA-{sid}"))
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// HighestAvailable requires one elevated registration. InteractiveToken keeps the helper on the user's desktop.
pub fn task_xml(exe: &str, sid: &str) -> Option<String> {
    run_value(exe)?;
    task_name(sid)?;
    if exe.chars().any(char::is_control) {
        return None;
    }
    let command = xml_escape(exe.trim());
    Some(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>{sid}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="NOVA"><UserId>{sid}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>false</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit></Settings>
<Actions Context="NOVA"><Exec><Command>{command}</Command></Exec></Actions>
</Task>"#
    ))
}

/// Only use a scheduled launch of this exact executable for this account, with no extra commands or arguments.
pub fn task_matches(xml: &str, exe: &str, sid: &str) -> bool {
    if task_xml(exe, sid).is_none() || xml.len() > 64 * 1024 {
        return false;
    }
    let command = format!("<Command>{}</Command>", xml_escape(exe.trim()));
    xml.contains(&command)
        && xml.matches("<Exec>").count() == 1
        && xml.matches("<Command>").count() == 1
        && xml.matches("<UserId>").count() == 2
        && xml.matches(&format!("<UserId>{sid}</UserId>")).count() == 2
        && xml.contains("<RunLevel>HighestAvailable</RunLevel>")
        && xml.contains("<LogonType>InteractiveToken</LogonType>")
        && !xml.contains("<Arguments>")
        && !xml.contains("<ComHandler")
        && !xml.contains("<SendEmail")
        && !xml.contains("<ShowMessage")
        && !xml.contains("<Enabled>false</Enabled>")
        && !xml.contains("<!DOCTYPE")
        && !xml.contains("<!ENTITY")
}

#[cfg(test)]
mod scheduled_tests {
    use super::*;
    #[test]
    fn task_is_interactive_and_scoped_to_current_user_and_executable() {
        let sid = "S-1-5-21-111-222-333-1001";
        let exe = "C:\\Program Files\\NOVA & tools\\nova.exe";
        let xml = task_xml(exe, sid).unwrap();
        assert!(xml.contains("NOVA &amp; tools"));
        assert!(xml.contains("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>"));
        assert!(task_matches(&xml, exe, sid));
        assert!(!task_matches(&xml, "C:\\Other\\nova.exe", sid));
        assert!(!task_matches(&xml, exe, "S-1-5-21-999-1001"));
        assert!(!xml.contains("Password"));
    }
    #[test]
    fn unrelated_extra_or_disabled_actions_are_not_used_for_elevation() {
        let sid = "S-1-5-21-1-1001";
        let exe = "C:\\NOVA\\nova.exe";
        let xml = task_xml(exe, sid).unwrap();
        for altered in [
            xml.replace("</Exec>", "<Arguments>--other</Arguments></Exec>"),
            xml.replace("</Actions>", "<Exec><Command>cmd.exe</Command></Exec></Actions>"),
            xml.replace("HighestAvailable", "LeastPrivilege"),
            xml.replace("<Enabled>true", "<Enabled>false"),
        ] {
            assert!(!task_matches(&altered, exe, sid));
        }
        assert!(task_name("S-1-5-21-1-1001").is_some());
        for sid in ["", "SYSTEM", "S-1-", "S-1-5--21", "S-1-5<evil>"] {
            assert!(task_name(sid).is_none());
        }
        assert!(task_xml("C:\\bad\r.exe", sid).is_none());
    }
}
