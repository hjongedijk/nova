# One-shot OpenSCAD renderer for NOVA's fabrication module. It has no entrypoint: stack-control starts it
# with no network, a read-only root, dropped capabilities and a small tmpfs, and reads the STL from stdout.
#   docker build -t nova-cad:openscad deploy/fabrication
FROM debian:trixie-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends openscad coreutils \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --uid 1000 --no-create-home --shell /usr/sbin/nologin cad
USER 1000:1000
WORKDIR /tmp
