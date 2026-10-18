#!/usr/bin/env node
// Read-only inventory: report file names and sizes, never configuration values or credentials.
import fs from "node:fs";
import path from "node:path";

const directory = path.resolve(process.argv[2] ?? "dev-data");
const categories = {
  history: [],
  configuration: [],
  state: [],
  database: [],
  recovery: [],
};
for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const name = entry.name;
  let category;
  if (/\.(?:sqlite|sqlite3|db)(?:-wal|-shm)?$/.test(name))
    category = "database";
  else if (/\.(?:bad|bak|tmp)$|\.before-|\.backup/.test(name))
    category = "recovery";
  else if (/history.*\.json$|\.jsonl$/.test(name)) category = "history";
  else if (
    /^(?:settings|services|mcp-servers|free-routing-policy)\.json$/.test(name)
  )
    category = "configuration";
  else if (/\.json$/.test(name)) category = "state";
  if (category)
    categories[category].push({
      name,
      bytes: fs.statSync(path.join(directory, name)).size,
    });
}
console.log(
  JSON.stringify(
    {
      directory,
      scope: "top-level regular files only; no contents read",
      categories,
    },
    null,
    2,
  ),
);
