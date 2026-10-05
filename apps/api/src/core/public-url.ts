/**
 * The address people use to reach NOVA from outside, for example behind a reverse proxy
 * (NOVA_PUBLIC_URL=https://nova.example.com). Only the origin is kept, so no port or path shows up
 * in links NOVA hands out. Empty when unset or not a web address.
 */
export function publicOrigin(value: string | undefined): string {
  const text = String(value ?? "").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    return url.origin;
  } catch {
    return "";
  }
}
