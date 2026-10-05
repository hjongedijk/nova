import crypto from "node:crypto";
import { Client } from "ssh2";

/** The login Termix holds for a host (from its export endpoint). Never stored or logged here. */
export interface SshLogin {
  ip: string;
  port?: number | string;
  username?: string;
  password?: string;
  key?: string;
  keyPassword?: string;
}

export interface SshOutcome {
  ok: boolean;
  error?: string;
  verified?: null;
  result?: {
    exitCode: number;
    success: boolean;
    output: string;
    error: string;
  };
}

/**
 * Termix stores the server key as the raw key in hex; older entries may hold a SHA-256 of it
 * (hex or "SHA256:" base64).
 */
export function sameHostKey(key: Buffer, stored: string): boolean {
  const raw = Buffer.from(key);
  const wanted = String(stored).trim();
  const hash = crypto.createHash("sha256").update(raw).digest();
  if (/^sha256:/i.test(wanted))
    return (
      wanted.slice(7).replace(/=+$/, "") ===
      hash.toString("base64").replace(/=+$/, "")
    );
  const hex = wanted.toLowerCase().replace(/:/g, "");
  return hex === raw.toString("hex") || hex === hash.toString("hex");
}

/** Run one command over SSH, but only on a server whose key is the one Termix knows. */
export function runDirectSsh(
  login: SshLogin,
  command: string,
  fingerprint: string,
  signal?: AbortSignal,
): Promise<SshOutcome> {
  return new Promise((resolve) => {
    const client = new Client();
    let finished = false;
    const finish = (outcome: SshOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.end();
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "De SSH-opdracht duurde te lang." }),
      40000,
    );
    signal?.addEventListener(
      "abort",
      () => finish({ ok: false, error: "Afgebroken." }),
      { once: true },
    );
    client.on("ready", () => {
      client.exec(command, (error, stream) => {
        if (error) return finish({ ok: false, error: error.message });
        let output = "";
        let errors = "";
        stream.on("data", (data: Buffer) => {
          if (output.length < 8000) output += data;
        });
        stream.stderr.on("data", (data: Buffer) => {
          if (errors.length < 8000) errors += data;
        });
        stream.on("close", (exitCode: number) =>
          finish({
            ok: true,
            verified: null,
            result: {
              exitCode,
              success: exitCode === 0,
              output: output.slice(0, 8000),
              error: errors.slice(0, 8000),
            },
          }),
        );
      });
    });
    client.on(
      "keyboard-interactive",
      (_name, _instructions, _lang, prompts, reply) =>
        reply(prompts.map(() => login.password || "")),
    );
    client.on("error", (error) =>
      finish({
        ok: false,
        error: /verification failed|host denied/i.test(error.message)
          ? "De sleutel van de server klopt niet met wat Termix kent; NOVA maakt geen verbinding."
          : /authentication/i.test(error.message)
            ? "De server weigerde de login uit Termix."
            : error.message,
      }),
    );
    client.connect({
      host: login.ip,
      port: Number(login.port) || 22,
      username: login.username,
      password: login.password || undefined,
      privateKey: login.key || undefined,
      passphrase: login.keyPassword || undefined,
      tryKeyboard: Boolean(login.password),
      readyTimeout: 15000,
      hostVerifier: (key: Buffer) => sameHostKey(key, fingerprint),
    });
  });
}
