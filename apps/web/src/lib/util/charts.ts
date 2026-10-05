import { MAX_HISTORY } from "#lib/stores/dashboard.svelte.ts";

/** Canvas drawing for the Server and Stem panels. Sizes are CSS pixels; the canvas is scaled for the device. */

export function prepareCanvas(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): CanvasRenderingContext2D | null {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** The entity's current accent colour as hue/saturation/lightness, read from --glow on <body>. */
export function glowHsl(): { h: number; s: number; l: number } {
  const probe = getComputedStyle(document.body).getPropertyValue("--glow");
  const rgb = probe.match(/[\d.]+/g)?.map(Number);
  if (probe.trim().startsWith("hsl") && rgb && rgb.length >= 3)
    return { h: rgb[0] ?? 191, s: rgb[1] ?? 90, l: rgb[2] ?? 68 };
  if (rgb && rgb.length >= 3) {
    const [r = 0, g = 0, b = 0] = rgb.map((v) => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    if (d === 0) return { h: 0, s: 0, l: l * 100 };
    const s = d / (1 - Math.abs(2 * l - 1));
    const h =
      max === r
        ? ((g - b) / d) % 6
        : max === g
          ? (b - r) / d + 2
          : (r - g) / d + 4;
    return { h: (h * 60 + 360) % 360, s: s * 100, l: l * 100 };
  }
  return { h: 191, s: 90, l: 68 };
}

export function drawNet(
  ctx: CanvasRenderingContext2D,
  hue: number,
  rx: number[],
  tx: number[],
): void {
  ctx.clearRect(0, 0, 212, 44);
  const top = Math.max(2048, ...rx, ...tx);
  const plot = (values: number[], color: string, fill: string | null) => {
    if (values.length < 2) return;
    const step = 212 / (MAX_HISTORY - 1);
    const x0 = 212 - (values.length - 1) * step;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = x0 + i * step;
      const y = 42 - (v / top) * 38;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.3;
    ctx.stroke();
    if (fill) {
      ctx.lineTo(212, 44);
      ctx.lineTo(x0, 44);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
  };
  plot(rx, `hsl(${hue} 90% 70%)`, `hsla(${hue},90%,70%,0.14)`);
  plot(tx, `hsl(${hue} 55% 88%)`, null);
}

export function drawChart(
  ctx: CanvasRenderingContext2D,
  hue: number,
  cpu: number[],
  memory: number[],
): void {
  ctx.clearRect(0, 0, 212, 60);
  ctx.lineWidth = 1;
  ctx.strokeStyle = "rgba(233,230,245,0.08)";
  ctx.beginPath();
  for (const y of [15, 30, 45]) {
    ctx.moveTo(0, y);
    ctx.lineTo(212, y);
  }
  ctx.stroke();
  const line = (
    values: number[],
    color: string,
    fill: string | null,
    dash: number[],
  ) => {
    if (values.length < 2) return;
    const step = 212 / (MAX_HISTORY - 1);
    const x0 = 212 - (values.length - 1) * step;
    ctx.beginPath();
    values.forEach((v, i) => {
      const x = x0 + i * step;
      const y = 58 - (Math.min(100, v) / 100) * 54;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    ctx.setLineDash(dash);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.setLineDash([]);
    if (fill) {
      ctx.lineTo(212, 60);
      ctx.lineTo(x0, 60);
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
  };
  line(cpu, `hsl(${hue} 90% 70%)`, `hsla(${hue},90%,70%,0.14)`, []);
  line(memory, `hsl(${hue} 60% 85%)`, null, [3, 3]);
}

/** The spectrum of NOVA's own voice: 24 bars. `t` is the time in seconds, `motion` 1 (or 0.35 when reduced). */
export function drawEq(
  ctx: CanvasRenderingContext2D,
  accent: { h: number; s: number; l: number },
  audio: { level: number; speaking: boolean; bands: Uint8Array | null },
  t: number,
  motion: number,
): void {
  ctx.clearRect(0, 0, 212, 40);
  ctx.fillStyle = `hsla(${accent.h},${accent.s}%,${accent.l}%,0.9)`;
  const bands = audio.speaking ? audio.bands : null;
  for (let i = 0; i < 24; i++) {
    const v = bands
      ? (bands[Math.floor((i / 24) * bands.length * 0.8)] ?? 0) / 255
      : audio.speaking
        ? audio.level * (0.6 + 0.4 * Math.sin(t * 8 + i))
        : 0.06 + 0.05 * Math.sin(t * 1.4 + i * 0.6) * motion;
    const h = Math.max(2, Math.min(1, v) * 40);
    ctx.fillRect(i * 8.9, (40 - h) / 2, 5.4, h);
  }
}
