# News and RSS

Without custom settings, NOVA reads NOS's public RSS topics (`algemeen`, `binnenland`, `buitenland`, `politiek`, `economie`, `tech`, `cultuur`, `opmerkelijk`, and `sport`). Ask for a short news briefing; NOVA uses only the returned headlines, names their sources, and can speak the summary when you ask to hear it.

To use your own feeds, set `NOVA_NEWS_FEEDS` in the local environment as a JSON array of up to five `{ "name", "url" }` entries, then restart NOVA. Example:

```dotenv
NOVA_NEWS_FEEDS=[{"name":"NOS","url":"https://feeds.nos.nl/nosnieuwsalgemeen"},{"name":"Tweakers","url":"https://feeds.tweakers.net/nieuws"}]
```

When configured, a news request reads each listed RSS feed in parallel and combines up to ten short headlines. Each result retains its source name. Feeds have a 500 KB response limit and seven-second timeout; unavailable feeds are skipped if another source works. NOVA accepts only HTTP(S) URLs without embedded credentials and checks the address again at fetch time, including after redirects, to block local/private network targets. Feed contents are untrusted text: NOVA summarizes them as news and never follows instructions found inside them. Feed names and URLs live in the local environment file, not the repository.
