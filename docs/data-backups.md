# Scheduled data backups

NOVA writes compressed local archives of its application data directory. A daily archive runs at 02:30 and a weekly archive runs on Sunday at 03:30, using `TZ` (default `Europe/Amsterdam`). If NOVA starts after a scheduled time and that period has no archive yet, it catches up once. Success and failure appear in the alert feed and are forwarded to the helper when it is connected.

If creation fails, NOVA retries the slot twice more, five minutes apart. It reports a critical failure only after the third attempt; a later scheduled slot can try again. Archive verification checks both the gzip/tar structure and a test extraction in the automated suite.

Production stores archives in `./nova-backups`, mounted at `/backups`; `NOVA_BACKUP_DIR` selects the destination. The default outside Compose is next to, not inside, `NOVA_DATA_DIR`. The backup directory is mode `0700`; each compressed archive is mode `0600`. NOVA keeps 14 daily and 8 weekly archives, removes older archives, and limits an archive to 1 GiB and the collection to 5 GiB. Create and own the directory as UID 1000 before starting Compose:

```sh
mkdir -p nova-data nova-backups nodered-data
sudo chown -R 1000:1000 nova-data nova-backups nodered-data
```

These archives contain private application files and may include credentials stored under `NOVA_DATA_DIR`. Keep the backup folder on a trusted local disk and restrict access to it. The current archive covers NOVA's application data directory only. It does not snapshot Qdrant, OmniRoute, Node-RED, Home Assistant, or other separate service volumes; those need their own backups before treating this as a full-stack recovery copy. No automatic restore is provided. Stop NOVA before manually extracting an archive into its data directory.
