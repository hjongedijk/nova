# Linphone encrypted-chat bridge (see docs/linphone-encrypted-chat.md). BUILT LOCALLY on the host, never pushed to a registry:
# the Belledonne wheel is GPLv3 (verified in linphone-5.5.32.dist-info/METADATA). Not part of the published NOVA image.
# Verified 2026-10-17: the pinned wheel installs on ubuntu:24.04 (Python 3.12), `import linphone` works headless.
# NOT verified: login, LIME enrolment and chat rooms with a real account.

# ---- builder: download + verify + install the wheel into a venv (curl and pip stay behind) ----
FROM ubuntu:24.04 AS builder
ARG LINPHONE_VERSION=5.5.32
ARG LINPHONE_WHEEL_SHA256=f18b962e17845ddeaf1ec66cbfd5e0a00883ae12cb1a8c4cab424204e64e631f
ARG LINPHONE_WHEEL_URL=https://download.linphone.org/releases/linphone-python/5.5/linux-x86_64/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
# Not on PyPI (PyPI "linphone" is the dead 3.9.1 python2 package). The file name must stay a valid wheel name for pip.
RUN curl -fsSL -o "/tmp/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl" "${LINPHONE_WHEEL_URL}" \
 && echo "${LINPHONE_WHEEL_SHA256}  /tmp/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl" | sha256sum -c - \
 && python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir "/tmp/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl" \
 && (/opt/venv/bin/pip uninstall -y pip setuptools >/dev/null 2>&1 || true) \
 && find /opt/venv -name '__pycache__' -type d -prune -exec rm -rf {} + \
 && rm -f /tmp/*.whl

# ---- runtime: only the shared libraries the wheel needs, non-root ----
FROM ubuntu:24.04
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 libpython3.12 libmariadb3 libasound2t64 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin nova-chat \
 && install -d -m 0700 -o nova-chat -g nova-chat /data
COPY --from=builder /opt/venv /opt/venv
COPY --chown=nova-chat:nova-chat bridge.py smoke_core.py test_bridge.py /app/

USER nova-chat
ENV HOME=/data PYTHONUNBUFFERED=1 NOVA_CHAT_HEALTH_PORT=8099
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/opt/venv/bin/python", "-I", "-c", "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ['NOVA_CHAT_HEALTH_PORT'], timeout=4)"]
ENTRYPOINT ["/opt/venv/bin/python", "-I", "/app/bridge.py"]
