/** "NOVA v0.1.73" for a release version ("0.1.73" or "v0.1.73"); "dev" is a development build. */
export function novaVersionLabel(version: string | null | undefined): string {
  const value = (version ?? "").trim();
  if (!value) return "NOVA";
  if (value === "dev") return "NOVA (ontwikkelbuild)";
  return `NOVA v${value.replace(/^v/, "")}`;
}
