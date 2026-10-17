import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { registerSecrets } from "../core/security/sanitize.js";

interface Entry {
  iv: string;
  tag: string;
  ct: string;
  label?: string;
  /** The only host this credential may ever be sent to (set at first use). */
  host?: string;
}
type Meta = { label?: string; host?: string };
interface VaultFile {
  v: 1;
  secrets: Record<string, Entry>;
}

export function writePrivateFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** Every string form in which a secret could be echoed back (raw, base64, url-encoded, basic-auth parts). */
export function secretForms(value: string): string[] {
  const forms = new Set<string>([value]);
  forms.add(Buffer.from(value).toString("base64"));
  forms.add(encodeURIComponent(value));
  if (value.includes(":")) {
    const [, ...rest] = value.split(":");
    if (rest.join(":").length >= 4) forms.add(rest.join(":"));
  }
  return [...forms].filter((form) => form.length >= 4);
}

/**
 * Encrypted credential store. Values are AES-256-GCM encrypted (per-entry IV, the reference as AAD) in
 * apis-secrets.json (0600). The key is a random 32-byte file apis.key (0600): NOVA's other secrets are
 * optional and can change, which would silently make the stored credentials unreadable, so the vault does
 * not derive from them. Plaintext lives only in memory and is registered with the global redaction.
 */
@Injectable()
export class ApiVault {
  private readonly file: string;
  private readonly keyFile: string;
  private key: Buffer | null = null;
  private cache: Map<string, string> | null = null;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("apis-secrets.json");
    this.keyFile = config.dataFile("apis.key");
  }

  private masterKey(): Buffer {
    if (this.key) return this.key;
    try {
      const raw = Buffer.from(
        fs.readFileSync(this.keyFile, "utf8").trim(),
        "base64",
      );
      if (raw.length === 32) return (this.key = raw);
    } catch {
      /* create below */
    }
    if (fs.existsSync(this.file) && Object.keys(this.readFile().secrets).length)
      throw new Error(
        "Vault key missing; stored credentials cannot be decrypted",
      );
    const fresh = crypto.randomBytes(32);
    writePrivateFile(this.keyFile, fresh.toString("base64"));
    return (this.key = fresh);
  }

  private readFile(): VaultFile {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.file, "utf8"),
      ) as VaultFile;
      if (parsed?.v === 1 && parsed.secrets) return parsed;
    } catch {
      /* empty vault */
    }
    return { v: 1, secrets: {} };
  }

  private load(): Map<string, string> {
    if (this.cache) return this.cache;
    const map = new Map<string, string>();
    const file = this.readFile();
    if (Object.keys(file.secrets).length) {
      const key = this.masterKey();
      for (const [ref, entry] of Object.entries(file.secrets)) {
        try {
          const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            key,
            Buffer.from(entry.iv, "base64"),
          );
          decipher.setAAD(Buffer.from(ref));
          decipher.setAuthTag(Buffer.from(entry.tag, "base64"));
          map.set(
            ref,
            Buffer.concat([
              decipher.update(Buffer.from(entry.ct, "base64")),
              decipher.final(),
            ]).toString("utf8"),
          );
        } catch {
          /* a damaged entry is skipped, never guessed */
        }
      }
    }
    this.cache = map;
    for (const value of map.values()) registerSecrets(secretForms(value));
    return map;
  }

  private persist(map: Map<string, string>, meta: Record<string, Meta>): void {
    const key = this.masterKey();
    const secrets: Record<string, Entry> = {};
    for (const [ref, value] of map) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(ref));
      const ct = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      secrets[ref] = {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ct: ct.toString("base64"),
        ...(meta[ref]?.label ? { label: meta[ref]!.label } : {}),
        ...(meta[ref]?.host ? { host: meta[ref]!.host } : {}),
      };
    }
    writePrivateFile(
      this.file,
      JSON.stringify({ v: 1, secrets } satisfies VaultFile),
    );
  }

  private metaAll(): Record<string, Meta> {
    return Object.fromEntries(
      Object.entries(this.readFile().secrets).map(([ref, entry]) => [
        ref,
        { label: entry.label, host: entry.host },
      ]),
    );
  }

  hostOf(ref: string): string | undefined {
    return this.readFile().secrets[ref]?.host;
  }

  /** Bind a credential to one host. A credential already bound elsewhere is never rebound. */
  bindHost(ref: string, host: string): boolean {
    const current = this.hostOf(ref);
    if (current) return current === host;
    const map = this.load();
    if (!map.has(ref)) return false;
    this.persist(map, {
      ...this.metaAll(),
      [ref]: { ...this.metaAll()[ref], host },
    });
    return true;
  }

  /** Store a value and return its opaque reference. */
  put(value: string, label?: string, host?: string): string {
    const map = this.load();
    for (const [ref, existing] of map)
      if (
        existing === value &&
        (!this.hostOf(ref) || this.hostOf(ref) === host)
      ) {
        if (host) this.bindHost(ref, host);
        return ref;
      }
    const ref = `sec_${crypto.randomBytes(5).toString("hex")}`;
    map.set(ref, value);
    registerSecrets(secretForms(value));
    this.persist(map, { ...this.metaAll(), [ref]: { label, host } });
    return ref;
  }

  /** Replace the value behind an existing reference (credential rotation by the user). */
  replace(ref: string, value: string): void {
    const map = this.load();
    map.set(ref, value);
    registerSecrets(secretForms(value));
    this.persist(map, this.metaAll());
  }

  get(ref: string): string | undefined {
    return this.load().get(ref);
  }

  has(ref: string): boolean {
    return this.load().has(ref);
  }

  delete(ref: string): void {
    const map = this.load();
    if (map.delete(ref)) this.persist(map, this.metaAll());
  }

  /** Replace every stored secret in `text`. */
  redact(text: string): string {
    let clean = text;
    for (const value of [...this.load().values()].sort(
      (a, b) => b.length - a.length,
    ))
      for (const form of secretForms(value))
        clean = clean.split(form).join("[redacted]");
    return clean;
  }

  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value))
      return value.map((item) => this.redactDeep(item)) as T;
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.redactDeep(item),
        ]),
      ) as T;
    return value;
  }
}

export const isSecretRef = (value: unknown): value is string =>
  typeof value === "string" && /^sec_[0-9a-f]{10}$/.test(value);
