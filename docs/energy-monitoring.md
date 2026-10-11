# Energy monitoring

When Home Assistant is connected, NOVA watches up to 100 `sensor` entities whose `device_class` is `power` and whose unit is W, kW or mW. It stores a small rolling 30-minute sample history in NOVA's private state file. After six samples, NOVA reports a power reading of at least 1,500 W that is also at least 2.5 times that sensor's recent average. The same sensor is quiet for one hour after an alert.

Energy totals such as kWh are not treated as instantaneous power. If Home Assistant has no eligible power sensor, this check stays inactive. Sampling and alerts are read-only; NOVA never changes a meter, switch or appliance. The thresholds are conservative fixed defaults, so verify the sensor's units and readings before relying on the alerts.
