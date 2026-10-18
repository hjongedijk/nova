import { Injectable } from "@nestjs/common";
import { NovaConfig } from "../core/config/nova-config.js";
import { requestJson } from "../core/http/http-json.js";
import { DESKTOP_LIMITS as L } from "./desktop.limits.js";
import type {
  DesktopAgentStatus,
  DesktopInputAction,
  DesktopOutcome,
  DesktopPort,
  DesktopScreenshot,
  DesktopWindow,
} from "./desktop.types.js";

const MIME = /^image\/(png|jpeg|webp)$/;
const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/** The Windows agent's /v1/desktop/* routes, with the same bearer token as the other agent tools. */
@Injectable()
export class DesktopAgentClient implements DesktopPort {
  constructor(private readonly config: NovaConfig) {}

  get configured(): boolean {
    return Boolean(
      this.config.windowsAgent.url && this.config.windowsAgent.token,
    );
  }

  private headers() {
    return { authorization: `Bearer ${this.config.windowsAgent.token}` };
  }

  private statusError(status: number): string {
    if (status === 501)
      return "Bureaubladbediening is nog niet beschikbaar in deze versie van NOVA voor Windows.";
    if (status === 404)
      return "De Windows-agent op de pc kent bureaubladbediening nog niet. Werk de agent bij.";
    if (status === 403 || status === 409)
      return "De Windows-agent weigert dit: bureaubladtoegang staat op de pc uit of is niet actief.";
    return "De Windows-agent reageert niet zoals verwacht.";
  }

  private async json(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<DesktopOutcome<{ data: Record<string, unknown> }>> {
    try {
      const response = await requestJson<Record<string, unknown>>(
        this.config.windowsAgent.url + path,
        {
          method,
          headers: this.headers(),
          body,
          signal,
          timeoutMs: 15_000,
        },
      );
      if (
        response.status !== 200 ||
        !response.data ||
        response.data.ok === false
      )
        return { ok: false, error: this.statusError(response.status) };
      return { ok: true, data: response.data };
    } catch {
      return {
        ok: false,
        error: "De Windows-agent antwoordt niet. Controleer of de pc aanstaat.",
      };
    }
  }

  async status(signal?: AbortSignal) {
    const r = await this.json("GET", "/v1/desktop/status", undefined, signal);
    if (!r.ok) return r;
    const d = r.data;
    const status: DesktopAgentStatus = {
      viewAvailable: d.view === true || d.viewAvailable === true,
      controlAvailable: d.control === true || d.controlAvailable === true,
      armed: d.armed === true,
      armedUntil: typeof d.armedUntil === "number" ? d.armedUntil : null,
      displays: Array.isArray(d.displays)
        ? d.displays.slice(0, 8).map((x: Record<string, unknown>, i) => ({
            index: num(x.index, i),
            width: num(x.width),
            height: num(x.height),
            primary: x.primary === true,
          }))
        : undefined,
    };
    return { ok: true as const, status };
  }

  async windows(signal?: AbortSignal) {
    const r = await this.json("GET", "/v1/desktop/windows", undefined, signal);
    if (!r.ok) return r;
    const list = Array.isArray(r.data.windows) ? r.data.windows : [];
    const windows: DesktopWindow[] = list
      .slice(0, 100)
      .flatMap((x: Record<string, unknown>) =>
        typeof x?.title === "string" &&
        (typeof x.id === "string" || typeof x.id === "number")
          ? [
              {
                id: String(x.id),
                title: x.title.slice(0, 200),
                process:
                  typeof x.process === "string"
                    ? x.process.slice(0, 60)
                    : undefined,
                active: x.active === true || x.foreground === true,
                display: typeof x.display === "number" ? x.display : undefined,
              },
            ]
          : [],
      );
    return { ok: true as const, windows };
  }

  /** Accepts a raw image/* body or JSON { image|data (base64), mimeType, width, height, display }. */
  async screenshot(
    options: { display?: number; maxWidth?: number },
    signal?: AbortSignal,
  ) {
    const query = new URLSearchParams();
    if (options.display !== undefined)
      query.set("display", String(options.display));
    query.set(
      "maxWidth",
      String(
        Math.min(
          L.maxMaxWidth,
          Math.max(L.minMaxWidth, options.maxWidth ?? L.defaultMaxWidth),
        ),
      ),
    );
    try {
      const response = await fetch(
        `${this.config.windowsAgent.url}/v1/desktop/screenshot?${query}`,
        {
          headers: this.headers(),
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(20_000)])
            : AbortSignal.timeout(20_000),
        },
      );
      if (response.status !== 200)
        return { ok: false as const, error: this.statusError(response.status) };
      const type =
        (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ??
        "";
      let shot: DesktopScreenshot;
      if (MIME.test(type)) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (!bytes.length || bytes.length > L.maxScreenshotBytes)
          return {
            ok: false as const,
            error: "De schermafbeelding is leeg of te groot.",
          };
        shot = {
          mimeType: type as DesktopScreenshot["mimeType"],
          base64: bytes.toString("base64"),
          width: num(Number(response.headers.get("x-nova-width"))),
          height: num(Number(response.headers.get("x-nova-height"))),
          display: options.display ?? 0,
        };
      } else {
        const body = (await response.json()) as Record<string, unknown>;
        const data = typeof body.image === "string" ? body.image : body.data;
        const mime =
          typeof body.mimeType === "string" ? body.mimeType : "image/png";
        if (
          typeof data !== "string" ||
          !MIME.test(mime) ||
          data.length > (L.maxScreenshotBytes * 4) / 3
        )
          return {
            ok: false as const,
            error: "De agent gaf een ongeldige schermafbeelding.",
          };
        shot = {
          mimeType: mime as DesktopScreenshot["mimeType"],
          base64: data.replace(/^data:[^,]*,/, ""),
          width: num(body.width),
          height: num(body.height),
          display: num(body.display, options.display ?? 0),
        };
      }
      return { ok: true as const, screenshot: shot };
    } catch {
      return {
        ok: false as const,
        error: "De Windows-agent antwoordt niet. Controleer of de pc aanstaat.",
      };
    }
  }

  async input(
    input: DesktopInputAction & {
      display?: number;
      relativeTo?: { width: number; height: number };
    },
    signal?: AbortSignal,
  ) {
    const r = await this.json("POST", "/v1/desktop/input", input, signal);
    return r.ok ? { ok: true as const } : r;
  }

  async control(armed: boolean, ttlSeconds: number, signal?: AbortSignal) {
    const r = await this.json(
      "POST",
      "/v1/desktop/control",
      armed
        ? { armed: true, ttlSeconds: Math.min(L.maxTtlSeconds, ttlSeconds) }
        : { armed: false },
      signal,
    );
    return r.ok ? { ok: true as const } : r;
  }
}
