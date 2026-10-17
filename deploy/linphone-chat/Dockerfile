# UNTESTED DRAFT (spike): headless Linphone SDK client that bridges Linphone end-to-end encrypted chat (LIME) to NOVA.
# What WAS verified (2026-10-17): the pinned wheel installs on ubuntu:24.04 (Python 3.12), `import linphone` works headless,
# a Core can be created without a sound card and reports its version. NOT verified: login, LIME enrolment, chat rooms (needs a real account).
# Licence: the wheel metadata says "License: GPLv3" (verified in linphone-5.5.32.dist-info/METADATA); see docs/linphone-encrypted-chat.md before distributing the image.
FROM ubuntu:24.04

ARG LINPHONE_VERSION=5.5.32
ARG LINPHONE_WHEEL_SHA256=f18b962e17845ddeaf1ec66cbfd5e0a00883ae12cb1a8c4cab424204e64e631f

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl libmariadb3 libasound2t64 libpython3.12 \
 && rm -rf /var/lib/apt/lists/*

# Official Belledonne wheel (cp312, bundles liblinphone, liblime, soci/sqlite, mbedtls). Not on PyPI (PyPI "linphone" is the dead 3.9.1 py2 package).
RUN curl -fsSL -o /tmp/linphone.whl \
      "https://download.linphone.org/releases/linphone-python/5.5/linux-x86_64/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl" \
 && echo "${LINPHONE_WHEEL_SHA256}  /tmp/linphone.whl" | sha256sum -c - \
 && python3 -m venv /opt/venv \
 && cp /tmp/linphone.whl "/tmp/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl" \
 && /opt/venv/bin/pip install --no-cache-dir "/tmp/linphone-${LINPHONE_VERSION}-cp312-cp312-linux_x86_64.whl" \
 && rm -f /tmp/linphone*.whl

RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin nova-chat \
 && install -d -m 0700 -o nova-chat -g nova-chat /data
COPY --chown=nova-chat:nova-chat bridge.py smoke_core.py /app/

USER nova-chat
ENV HOME=/data PYTHONUNBUFFERED=1 NOVA_CHAT_HEALTH_PORT=8099
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${NOVA_CHAT_HEALTH_PORT}/health" || exit 1
ENTRYPOINT ["/opt/venv/bin/python", "-I", "/app/bridge.py"]
