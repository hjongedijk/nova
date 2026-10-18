//! Update lifecycle. A background check can announce an update but cannot install it.
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Installing,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub current_version: String,
    pub version: Option<String>,
    pub notes: Option<String>,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub error: Option<String>,
}

impl Status {
    pub fn new(version: String) -> Self {
        Self {
            phase: Phase::Idle,
            current_version: version,
            version: None,
            notes: None,
            downloaded: 0,
            total: None,
            error: None,
        }
    }
    pub fn begin_check(&mut self) -> Result<(), String> {
        if matches!(self.phase, Phase::Checking | Phase::Downloading | Phase::Installing) {
            return Err("Er is al een update-actie bezig".into());
        }
        self.phase = Phase::Checking;
        self.error = None;
        self.version = None;
        self.notes = None;
        self.downloaded = 0;
        self.total = None;
        Ok(())
    }
    pub fn checked(&mut self, release: Option<(String, Option<String>)>) {
        match release {
            Some((version, notes)) => {
                self.phase = Phase::Available;
                self.version = Some(version);
                self.notes = notes;
            }
            None => {
                self.phase = Phase::Current;
            }
        }
    }
    pub fn begin_install(&mut self) -> Result<(), String> {
        if self.phase != Phase::Available || self.version.is_none() {
            return Err("Controleer eerst of er een update beschikbaar is".into());
        }
        self.phase = Phase::Downloading;
        self.downloaded = 0;
        self.total = None;
        self.error = None;
        Ok(())
    }
    pub fn failed(&mut self, message: &str) {
        self.phase = Phase::Failed;
        self.error = Some(message.into());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checks_never_install_and_installs_require_an_available_release() {
        let mut state = Status::new("0.1.74".into());
        assert!(state.begin_install().is_err());
        state.begin_check().unwrap();
        assert!(state.begin_install().is_err());
        state.checked(Some(("0.1.75".into(), None)));
        assert_eq!(state.phase, Phase::Available);
        state.begin_install().unwrap();
        assert_eq!(state.phase, Phase::Downloading);
    }
    #[test]
    fn concurrent_requests_cannot_reset_an_active_download() {
        let mut state = Status::new("0.1.74".into());
        state.begin_check().unwrap();
        assert!(state.begin_check().is_err());
        state.checked(Some(("0.1.75".into(), None)));
        state.begin_install().unwrap();
        state.downloaded = 1234;
        assert!(state.begin_check().is_err());
        assert!(state.begin_install().is_err());
        assert_eq!(state.downloaded, 1234);
        state.phase = Phase::Installing;
        assert!(state.begin_check().is_err());
    }
    #[test]
    fn failure_requires_a_new_check_and_clears_stale_progress() {
        let mut state = Status::new("0.1.74".into());
        state.begin_check().unwrap();
        state.checked(Some(("0.1.75".into(), None)));
        state.begin_install().unwrap();
        state.failed("Download mislukt");
        assert!(state.begin_install().is_err());
        state.begin_check().unwrap();
        assert!(state.error.is_none());
        assert!(state.version.is_none());
        state.checked(None);
        assert_eq!(state.phase, Phase::Current);
        assert!(state.begin_install().is_err());
    }
}
