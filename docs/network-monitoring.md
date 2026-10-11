# Network and device monitoring

The watchdog checks Internet reachability separately from DNS resolution, so it can label an outage more precisely. Each check runs once per minute and raises an alert after two consecutive failures; a recovery alert appears when the check succeeds again. The Internet probe uses HTTPS to `1.1.1.1`; DNS resolves `cloudflare.com`. Custom `NOVA_CHECK_TARGETS` add or replace service checks while keeping these two probes enabled. Set entries as `name=url`, comma-separated, for example `nas=tcp://192.0.2.10:445`.

When Home Assistant is configured, NOVA compares the `device_tracker` entity IDs returned by its normal state sync. The first successful inventory establishes a baseline. Later additions and removals become informational alerts; NOVA does not store IP or MAC addresses. A failed Home Assistant sync never counts as devices disappearing. This detects changes to Home Assistant's tracker inventory, not every device that joins the Wi-Fi network; configure a router or access-point integration in Home Assistant for that coverage.

Network checks and tracker inventory are read-only. Internet and DNS checks continue when custom service targets are configured. Home Assistant inventory monitoring uses the existing Home Assistant connection and requires no additional permissions.
