# Asterisk 22 (GPL-2.0 with OpenSSL exception) from the community-maintained andrius/asterisk image.
# The wrapper only adds NOVA's config sync; Asterisk itself is unmodified.
FROM andrius/asterisk:22@sha256:1817983370bf2bcd645e836f9149cd1a743fef2f48a47b59bd77a86fd4b48b9b

COPY --chmod=0755 nova-entrypoint.sh /usr/local/bin/nova-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/nova-entrypoint.sh"]
CMD ["/usr/sbin/asterisk", "-f", "-n", "-U", "asterisk", "-G", "asterisk"]
