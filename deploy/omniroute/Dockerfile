# Keep the gateway and its data format on the audited upstream build.
FROM diegosouzapw/omniroute@sha256:8bd462c9f60d8eda79329cfbb6ea7ea723505fe7721beb944f3d43835409e218
COPY --chown=node:node repair-stream-content.mjs verify-stream-content.mjs /tmp/
RUN node /tmp/repair-stream-content.mjs /app \
 && node /tmp/verify-stream-content.mjs /app \
 && rm /tmp/repair-stream-content.mjs /tmp/verify-stream-content.mjs
