# HTTPS certificate monitoring

When `NOVA_PUBLIC_URL` is a reachable HTTPS address, the watchdog reads its TLS peer certificate once per minute. It warns at 30 days remaining and marks the alert critical at seven days or less, including after expiry. It checks only this configured HTTPS endpoint; an unset, non-HTTPS, or unreachable address creates no expiry alert. NOVA does not renew or replace certificates.

Configure `NOVA_PUBLIC_URL` as the HTTPS address users actually open. If TLS terminates at a reverse proxy, NOVA must be able to reach that same public endpoint from its network. Check the reverse proxy's renewal job separately; the alert only reports what the endpoint currently serves.
