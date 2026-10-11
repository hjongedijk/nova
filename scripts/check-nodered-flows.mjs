import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve(process.argv[2] || "deploy/nodered/flows.json");
const credentialKey =
  /(?:password|passwd|token|api[_-]?key|secret|credential|private[_-]?key|client[_-]?secret)/i;
const placeholders =
  /^(?:|change[_ -]?me|replace[_ -]?me|your[_ -].*|<[^>]+>|\$\{[^}]+\})$/i;
const embeddedSecret =
  /\bBearer\s+[A-Za-z0-9._~+/-]{24,}|\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{20,}/i;

let document;
try {
  document = JSON.parse(readFileSync(target, "utf8"));
} catch {
  console.error(`Node-RED flow check: cannot read valid JSON from ${target}`);
  process.exit(1);
}

if (!Array.isArray(document)) {
  console.error(`Node-RED flow check: expected a flow array in ${target}`);
  process.exit(1);
}

const findings = [];
function inspect(value, path = "$", key = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspect(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value))
      inspect(child, `${path}.${childKey}`, childKey);
    return;
  }
  if (typeof value !== "string" || !value.trim()) return;
  if (
    (credentialKey.test(key) && !placeholders.test(value.trim())) ||
    embeddedSecret.test(value)
  )
    findings.push(path);
}

inspect(document);
if (findings.length) {
  console.error(
    `Node-RED flow check: possible secret at ${findings.slice(0, 10).join(", ")}`,
  );
  process.exit(1);
}
console.log(`Node-RED flow check passed: ${target}`);
