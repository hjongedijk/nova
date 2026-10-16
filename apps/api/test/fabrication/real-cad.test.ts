import { execFile } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  analyzeMesh,
  parseStl,
  printabilityIssues,
} from "../../src/fabrication/mesh.js";
import {
  getTemplate,
  listTemplates,
  normalizeParams,
} from "../../src/fabrication/templates.js";

/**
 * Renders with the real nova-cad:openscad image (build it with `docker build -t nova-cad:openscad deploy/fabrication`)
 * using the same isolation flags stack-control applies. Opt-in: NOVA_TEST_DOCKER_CAD=1.
 */
const enabled = process.env.NOVA_TEST_DOCKER_CAD === "1";

function render(scad: string): Promise<Buffer> {
  const script =
    'set -eu; printf %s "$SCAD_B64" | base64 -d > /tmp/in.scad; openscad -o /tmp/out.stl --export-format binstl /tmp/in.scad 1>&2; base64 -w0 /tmp/out.stl';
  return new Promise((resolve, reject) =>
    execFile(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=96m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--memory",
        "768m",
        "--pids-limit",
        "64",
        "-e",
        "HOME=/tmp",
        "-e",
        `SCAD_B64=${Buffer.from(scad).toString("base64")}`,
        "nova-cad:openscad",
        "sh",
        "-c",
        script,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
      (error, stdout) =>
        error ? reject(error) : resolve(Buffer.from(stdout.trim(), "base64")),
    ),
  );
}

describe.skipIf(!enabled)("real OpenSCAD in the sandbox", () => {
  const cases: [string, Record<string, unknown>][] = [
    ["wall_bracket", {}],
    [
      "wall_bracket",
      { width: 120, holes: 4, holeDiameter: 5, cornerRadius: 6 },
    ],
    [
      "wall_bracket",
      { width: 80, height: 40, depth: 30, thickness: 4, holes: 2 },
    ],
    ["plate", {}],
    [
      "plate",
      { width: 150, depth: 90, thickness: 3, holes: 6, cornerRadius: 0 },
    ],
    ["enclosure", {}],
    [
      "enclosure",
      { innerWidth: 100, innerDepth: 60, innerHeight: 30, wall: 2.4, lid: 0 },
    ],
    ["headset_stand", {}],
    [
      "headset_stand",
      { baseWidth: 150, baseDepth: 140, postHeight: 240, armLength: 70 },
    ],
  ];

  for (const [id, params] of cases)
    it(`${id} ${JSON.stringify(params)} matches its promised size and is printable`, async () => {
      const t = getTemplate(id);
      const normalized = normalizeParams(t, params);
      const built = t.build(normalized);
      const report = analyzeMesh(parseStl(await render(built.scad)));
      built.expected.forEach((value, i) =>
        expect(report.bounds.size[i]!).toBeCloseTo(value, 1),
      );
      expect(report.watertight).toBe(true);
      expect(
        printabilityIssues(report, { x: 256, y: 256, z: 256 }).filter(
          (i) => i.level === "error",
        ),
      ).toEqual([]);
    }, 90_000);

  it("a bracket with four 5 mm holes has the volume of the solid minus the holes", async () => {
    const t = getTemplate("wall_bracket");
    const withHoles = analyzeMesh(
      parseStl(
        await render(
          t.build(normalizeParams(t, { holes: 4, holeDiameter: 5 })).scad,
        ),
      ),
    );
    const without = analyzeMesh(
      parseStl(await render(t.build(normalizeParams(t, { holes: 0 })).scad)),
    );
    // 4 holes of d=5 through the 5 mm plate: 4 * pi * 2.5^2 * 5 ≈ 392.7 mm³ (a 48-sided cylinder is slightly smaller)
    expect(without.volumeMm3 - withHoles.volumeMm3).toBeGreaterThan(370);
    expect(without.volumeMm3 - withHoles.volumeMm3).toBeLessThan(395);
  }, 90_000);

  it("rejects broken OpenSCAD instead of producing a model", async () => {
    await expect(render("cube(")).rejects.toThrow();
  }, 90_000);

  it("keeps the template list honest", () => {
    expect(listTemplates().length).toBe(4);
  });
});
