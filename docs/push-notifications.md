# Urgent phone notifications

NOVA can publish critical alerts to an ntfy topic. Install the ntfy app on the phone and subscribe
to a private topic on the same ntfy server that NOVA can reach. Give NOVA a publish-only access
token, then set `NTFY_URL`, `NTFY_TOPIC`, and `NTFY_TOKEN` in the deployment `.env` and restart NOVA.
The `NTFY_URL` may use HTTPS, or HTTP only for the local `ntfy`, `localhost`, or `127.0.0.1` host.

NOVA sends only the sanitized alert title, with urgent priority. A title can contain an integration
or device name, so use an ntfy server and private topic you trust. NOVA does not send event details,
tool arguments, or tool results. Only `critical` alerts are pushed, and repeats with the same key
and title are suppressed for 15 minutes while NOVA is running. All alerts remain in the normal
NOVA feed. Delivery failures are logged without the endpoint or token and do not affect the feed.

Keep the topic private and use a token that can publish but cannot read other topics. ntfy supports
Bearer access tokens for protected topics and an HTTP publish endpoint with a priority header;
see the [ntfy publishing documentation](https://docs.ntfy.sh/publish/).
