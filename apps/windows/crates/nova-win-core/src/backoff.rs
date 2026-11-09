//! Retry schedules. NOVA keeps trying on its own (server unreachable, port taken, update feed down) without
//! hammering anything and without asking the user.
use std::time::Duration;

/// Exponential backoff: `base * 2^attempt`, capped. `attempt` 0 is the first retry.
pub fn exponential(attempt: u32, base: Duration, cap: Duration) -> Duration {
    let factor = 1u32.checked_shl(attempt.min(16)).unwrap_or(u32::MAX);
    base.saturating_mul(factor).min(cap)
}

/// Reloading a NOVA page after the server could not be reached: 5 s, 10 s, 20 s, 40 s, then every minute.
pub fn page_reload(attempt: u32) -> Duration {
    exponential(attempt, Duration::from_secs(5), Duration::from_secs(60))
}

/// Binding the agent's HTTP port after it was taken: 5 s, 10 s, 20 s, then every 30 seconds.
pub fn listener(attempt: u32) -> Duration {
    exponential(attempt, Duration::from_secs(5), Duration::from_secs(30))
}

/// The next automatic update check. A successful check waits six hours; a failed one (no network yet right
/// after sign-in, GitHub down) retries after 2, 4, 8 ... minutes, at most one hour.
pub fn update_check(consecutive_failures: u32) -> Duration {
    if consecutive_failures == 0 {
        Duration::from_secs(6 * 60 * 60)
    } else {
        exponential(
            consecutive_failures - 1,
            Duration::from_secs(120),
            Duration::from_secs(60 * 60),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exponential_grows_and_caps_without_overflow() {
        let base = Duration::from_secs(5);
        let cap = Duration::from_secs(60);
        assert_eq!(exponential(0, base, cap), Duration::from_secs(5));
        assert_eq!(exponential(1, base, cap), Duration::from_secs(10));
        assert_eq!(exponential(3, base, cap), Duration::from_secs(40));
        assert_eq!(exponential(4, base, cap), cap);
        assert_eq!(exponential(u32::MAX, base, cap), cap);
    }
    #[test]
    fn schedules_match_their_documentation() {
        assert_eq!(page_reload(0), Duration::from_secs(5));
        assert_eq!(page_reload(10), Duration::from_secs(60));
        assert_eq!(listener(0), Duration::from_secs(5));
        assert_eq!(listener(9), Duration::from_secs(30));
        assert_eq!(update_check(0), Duration::from_secs(21600));
        assert_eq!(update_check(1), Duration::from_secs(120));
        assert_eq!(update_check(2), Duration::from_secs(240));
        assert_eq!(update_check(50), Duration::from_secs(3600));
    }
}
