/*
 * Live terminal output for the screen, chunk by chunk, without changing what the model gets. Output is redacted
 * line by line (a secret split over two chunks is still caught, because a partial line waits up to HOLD_MS for its
 * end), terminal escape codes other than colours are removed (no clipboard writes, titles or cursor tricks from a
 * remote host), and everything is bounded: small events, a total per command.
 */
import type { NovaTerminalEvent } from "@nova/contracts";
import { maskSecrets } from "../chat/tool-preview.js";

export const TERMINAL_LIMITS = {
  flushMs: 70,
  holdMs: 300,
  maxEventChars: 4000,
  maxTotalChars: 256_000,
} as const;

/** Keeps SGR colour codes (ESC [ ... m), line breaks, tabs and carriage returns; drops every other control. */
/* eslint-disable no-control-regex -- terminal escape codes are control characters by definition */
export function cleanTerminal(text: string): string {
  return (
    text
      // OSC (title, clipboard, hyperlinks) and DCS/PM/APC strings.
      .replace(/\u001b[\]P^_][\s\S]*?(?:\u0007|\u001b\\|$)/g, "")
      // CSI sequences that are not colours.
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, (sequence) =>
        /^\u001b\[[0-9;]*m$/.test(sequence) ? sequence : "",
      )
      // Any other escape.
      .replace(/\u001b(?!\[[0-9;]*m)./g, "")
      .replace(
        /[\u0000-\u0007\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g,
        "",
      )
  );
}

/* eslint-enable no-control-regex */

/** Redact one complete piece of output (whole lines). */
export const redactTerminal = (text: string): string =>
  maskSecrets(cleanTerminal(text));

type Emit = (event: "terminal", data: NovaTerminalEvent) => void;

export class TerminalRelay {
  private pending: Record<"stdout" | "stderr", string> = {
    stdout: "",
    stderr: "",
  };
  private since: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private total = 0;
  private started = Date.now();
  streamed = false;
  ended = false;

  constructor(
    readonly id: string,
    private readonly emit: Emit,
    private readonly now: () => number = Date.now,
  ) {}

  start(info: { host?: string; user?: string; command: string; tool: string }) {
    this.started = this.now();
    this.emit("terminal", {
      id: this.id,
      phase: "start",
      ...(info.host ? { host: maskSecrets(info.host).slice(0, 80) } : {}),
      ...(info.user ? { user: maskSecrets(info.user).slice(0, 40) } : {}),
      command: redactTerminal(info.command).slice(0, 2000),
      tool: info.tool,
    });
  }

  write(stream: "stdout" | "stderr", chunk: string | Buffer) {
    if (this.ended || this.total >= TERMINAL_LIMITS.maxTotalChars) return;
    this.pending[stream] += String(chunk);
    this.since ??= this.now();
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(false), TERMINAL_LIMITS.flushMs);
      this.timer.unref?.();
    }
  }

  /** Send whole lines now; a partial line waits for its end unless `all` or it has waited long enough. */
  flush(all: boolean) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const waited =
      this.since !== null && this.now() - this.since >= TERMINAL_LIMITS.holdMs;
    for (const stream of ["stdout", "stderr"] as const) {
      const text = this.pending[stream];
      if (!text) continue;
      const cut = all || waited ? text.length : text.lastIndexOf("\n") + 1;
      if (cut <= 0) continue;
      this.pending[stream] = text.slice(cut);
      this.send(stream, text.slice(0, cut));
    }
    const left = this.pending.stdout || this.pending.stderr;
    this.since = left ? (this.since ?? this.now()) : null;
    if (left && !this.timer && !this.ended) {
      this.timer = setTimeout(() => this.flush(false), TERMINAL_LIMITS.flushMs);
      this.timer.unref?.();
    }
  }

  private send(stream: "stdout" | "stderr", raw: string) {
    let text = redactTerminal(raw);
    const room = TERMINAL_LIMITS.maxTotalChars - this.total;
    if (room <= 0) return;
    if (text.length > room)
      text = `${text.slice(0, room)}\r\n… (uitvoer ingekort)\r\n`;
    this.total += text.length;
    for (let i = 0; i < text.length; i += TERMINAL_LIMITS.maxEventChars) {
      this.streamed = true;
      this.emit("terminal", {
        id: this.id,
        phase: "data",
        stream,
        data: text.slice(i, i + TERMINAL_LIMITS.maxEventChars),
      });
    }
  }

  end(outcome: {
    ok: boolean;
    exitCode?: number | null;
    output?: string;
    errors?: string;
  }) {
    if (this.ended) return;
    // Buffered tools (Termix snippets, the code runner) deliver everything at the end.
    if (!this.streamed) {
      if (outcome.output) this.pending.stdout += outcome.output;
      if (outcome.errors) this.pending.stderr += outcome.errors;
    }
    this.flush(true);
    this.ended = true;
    this.emit("terminal", {
      id: this.id,
      phase: "end",
      ok: outcome.ok,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      durationMs: Math.max(0, this.now() - this.started),
    });
  }
}

/** Tools whose output belongs in a terminal window. */
export const isTerminalTool = (name: string) =>
  name === "termix_run_command" || name === "code_run_tests";
