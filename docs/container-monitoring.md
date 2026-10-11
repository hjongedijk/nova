# Container and NOVA release alerts

In the official Compose deployment, the watchdog reads fixed container IDs through the private stack-control broker once per minute. It records the first complete status as a baseline, then reports a stopped/missing container, recovery, or a changed NOVA/Compose container start time. A broker outage or incomplete status is ignored rather than interpreted as a container outage. Container monitoring requires a valid `NOVA_STACK_CONTROL_TOKEN`; the broker keeps the Docker socket and NOVA receives only fixed service IDs, state, health and start time.

When NOVA runs a numbered release, it checks GitHub's public latest stable release every six hours. A new version creates one informational alert until the release version changes or NOVA catches up. Development builds such as `dev` cannot be compared. This read-only check never pulls an image, restarts a service or changes `NOVA_VERSION`; use the documented release/update steps to install an update.
