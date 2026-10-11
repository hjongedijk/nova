#!/bin/sh
set -eu

# Seed only absent files. Node-RED owns /data after initialization, so user edits
# and credentials survive every later image update and container restart.
seed_dir=${NOVA_NODE_RED_SEED_DIR:-/opt/nova/nodered-seed}
data_dir=${NOVA_NODE_RED_DATA_DIR:-/data}
for file in flows.json settings.js package.json; do
  if [ ! -e "$data_dir/$file" ]; then
    cp "$seed_dir/$file" "$data_dir/$file"
  fi
done

# Install or refresh NOVA's local node package without consulting a public registry.
# It is versioned with the read-only seed mount and its sources never live in flows.
nova_module="$seed_dir/node-red-contrib-nova"
if [ -f "$nova_module/package.json" ]; then
  seed_version=$(node -p 'require(process.argv[1]).version' "$nova_module/package.json")
  installed_version=$(node -p 'require(process.argv[1]).version' "$data_dir/node_modules/node-red-contrib-nova/package.json" 2>/dev/null || true)
  if [ "$installed_version" != "$seed_version" ]; then
    if npm install --prefix "$data_dir" --omit=dev --no-audit --no-fund "$nova_module"; then
      echo "Installed node-red-contrib-nova $seed_version"
    else
      echo "Warning: NOVA custom nodes could not be installed; Node-RED will start without them." >&2
    fi
  fi
fi

exec "${NOVA_NODE_RED_ENTRYPOINT:-/usr/src/node-red/entrypoint.sh}" "$@"
