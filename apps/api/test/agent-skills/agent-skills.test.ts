import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  AgentSkillsService,
  SKILLS_PROMPT_BUDGET,
} from "../../src/agent-skills/agent-skills.service.js";
import { AgentSkillsSource } from "../../src/agent-skills/agent-skills.source.js";
import {
  parseSkillMarkdown,
  referencePath,
  SkillFormatError,
} from "../../src/agent-skills/skill-format.js";
import {
  parseSkillSource,
  SkillInstallerService,
  type SkillFetch,
} from "../../src/agent-skills/skill-installer.service.js";
import {
  MAX_MODEL_TOOLS,
  selectToolsForRequest,
} from "../../src/tools/tool-selection.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nova-skills-"));
  roots.push(root);
  const skills = new AgentSkillsService({
    dataFile: (name: string) => path.join(root, name),
  } as NovaConfig);
  const installer = new SkillInstallerService(skills);
  return { root, skills, installer, dir: path.join(root, "agent-skills") };
}

const skillMd = (name: string, description = `Helps with ${name} tasks.`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nDo the thing step by step.\n`;

function place(dir: string, name: string, text = skillMd(name)) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), text);
}

describe("SKILL.md parser", () => {
  it("reads the specification fields, block scalars and metadata", () => {
    const parsed = parseSkillMarkdown(
      [
        "---",
        "name: pdf-processing",
        "description: >",
        "  Extract text from PDFs.",
        "  Use when handling PDFs.",
        "license: Apache-2.0",
        "metadata:",
        "  author: example-org",
        '  version: "1.0"',
        "allowed-tools: Read",
        "tags:",
        "  - pdf",
        "---",
        "# Body",
      ].join("\r\n"),
      "pdf-processing",
    );
    expect(parsed).toMatchObject({
      name: "pdf-processing",
      description: "Extract text from PDFs. Use when handling PDFs.",
      license: "Apache-2.0",
      metadata: { author: "example-org", version: "1.0" },
      allowedTools: "Read",
      body: "# Body",
      ignoredKeys: ["tags"],
    });
    expect(
      parseSkillMarkdown(
        '---\nname: q\ndescription: "You MUST use this: before work"\n---\nx',
      ).description,
    ).toBe("You MUST use this: before work");
  });

  it.each([
    ["no frontmatter", "# Just markdown"],
    ["unclosed", "---\nname: a\ndescription: b\n"],
    ["missing name", "---\ndescription: b\n---\n"],
    ["missing description", "---\nname: a\n---\n"],
    ["uppercase name", "---\nname: Abc\ndescription: b\n---\n"],
    ["double hyphen", "---\nname: a--b\ndescription: b\n---\n"],
    ["leading hyphen", "---\nname: -a\ndescription: b\n---\n"],
    ["duplicate key", "---\nname: a\nname: a\ndescription: b\n---\n"],
    [
      "long description",
      `---\nname: a\ndescription: ${"x".repeat(1025)}\n---\n`,
    ],
    ["bad metadata", "---\nname: a\ndescription: b\nmetadata: text\n---\n"],
    ["too big", `---\nname: a\ndescription: b\n---\n${"x".repeat(70_000)}`],
  ])("rejects %s", (_label, text) => {
    expect(() => parseSkillMarkdown(text)).toThrow(SkillFormatError);
  });

  it("requires the name to match its folder", () => {
    expect(() => parseSkillMarkdown(skillMd("one"), "two")).toThrow(
      /komt niet overeen/,
    );
  });

  it("accepts only shallow text reference paths", () => {
    expect(referencePath("references/REFERENCE.md")).toBe(
      "references/REFERENCE.md",
    );
    expect(referencePath("LICENSE.txt")).toBe("LICENSE.txt");
    for (const bad of [
      "../secret.md",
      "/etc/passwd",
      "a/../../b.md",
      ".hidden/x.md",
      "scripts/run.py",
      "a\\b.md",
      "a/b/c/d/e.md",
      "",
    ])
      expect(referencePath(bad)).toBeNull();
  });
});

describe("installed skills", () => {
  it("lists folders, flags invalid ones and ignores symlinks", () => {
    const { skills, dir, root } = setup();
    place(dir, "writing");
    place(dir, "broken", "no frontmatter");
    fs.mkdirSync(path.join(root, "elsewhere"));
    fs.writeFileSync(
      path.join(root, "elsewhere", "SKILL.md"),
      skillMd("linked"),
    );
    fs.symlinkSync(path.join(root, "elsewhere"), path.join(dir, "linked"));
    const list = skills.list();
    expect(list.map((skill) => skill.name)).toEqual(["broken", "writing"]);
    expect(list[0]!.error).toBeTruthy();
    expect(skills.enabledSkills().map((skill) => skill.name)).toEqual([
      "writing",
    ]);
  });

  it("skill_read returns the body and only safe reference files", () => {
    const { skills, dir, root } = setup();
    place(dir, "writing");
    fs.mkdirSync(path.join(dir, "writing", "references"));
    fs.writeFileSync(
      path.join(dir, "writing", "references", "style.md"),
      "Be brief.",
    );
    fs.writeFileSync(path.join(root, "secret.md"), "top secret");
    fs.symlinkSync(
      path.join(root, "secret.md"),
      path.join(dir, "writing", "leak.md"),
    );
    fs.writeFileSync(path.join(dir, "writing", "run.py"), "print(1)");
    expect(skills.read("writing").content).toContain("Do the thing");
    expect(skills.read("writing").files).toEqual(["references/style.md"]);
    expect(skills.read("writing", "references/style.md").content).toBe(
      "Be brief.",
    );
    for (const file of ["leak.md", "../../secret.md", "/etc/passwd", "run.py"])
      expect(() => skills.read("writing", file)).toThrow(/niet gevonden/);
    expect(() => skills.read("../writing")).toThrow();
    skills.setEnabled("writing", false);
    expect(() => skills.read("writing")).toThrow(/staat uit/);
  });

  it("keeps the prompt section within its budget and points to skill_list", () => {
    const { skills, dir } = setup();
    expect(skills.promptSection()).toBeNull();
    for (let index = 0; index < 40; index += 1)
      place(
        dir,
        `skill-${index}`,
        skillMd(`skill-${index}`, "word ".repeat(150)),
      );
    const section = skills.promptSection()!;
    expect(section.length).toBeLessThanOrEqual(SKILLS_PROMPT_BUDGET);
    expect(section).toMatch(/^SKILLS/);
    expect(section).toContain("skill_read");
    expect(section).toMatch(/\+\d+ more skills; call skill_list/);
    skills.setEnabled("skill-0", false);
    expect(skills.promptSection()).not.toContain("- skill-0:");
  });

  it("removes a skill folder", () => {
    const { skills, dir } = setup();
    place(dir, "writing");
    skills.remove("writing");
    expect(fs.existsSync(path.join(dir, "writing"))).toBe(false);
    expect(() => skills.remove("writing")).toThrow(/bestaat niet/);
  });

  it("pins skill_read in large tool catalogs", () => {
    const tools = Array.from({ length: 60 }, (_, index) => ({
      type: "function" as const,
      function: {
        name: `weather_${index}`,
        description: "weather",
        parameters: {},
      },
    }));
    tools.push({
      type: "function",
      function: {
        name: "skill_read",
        description: "Read a skill",
        parameters: {},
      },
    });
    const selected = selectToolsForRequest(
      tools,
      "what is the weather",
      "conversation",
    );
    expect(selected.length).toBeLessThanOrEqual(MAX_MODEL_TOOLS);
    expect(selected.map((tool) => tool.function.name)).toContain("skill_read");
  });
});

describe("installing from GitHub", () => {
  it.each([
    [
      "obra/superpowers@brainstorming",
      { owner: "obra", repo: "superpowers", skill: "brainstorming" },
    ],
    [
      "vercel-labs/agent-skills/writing-guidelines",
      {
        owner: "vercel-labs",
        repo: "agent-skills",
        skill: "writing-guidelines",
      },
    ],
    [
      "https://github.com/anthropics/skills",
      { owner: "anthropics", repo: "skills" },
    ],
    [
      "https://github.com/anthropics/skills/tree/main/skills/doc-coauthoring",
      {
        owner: "anthropics",
        repo: "skills",
        ref: "main",
        path: "skills/doc-coauthoring",
      },
    ],
    [
      "https://skills.sh/obra/superpowers/brainstorming",
      { owner: "obra", repo: "superpowers", skill: "brainstorming" },
    ],
  ])("parses %s", (input, expected) => {
    expect(parseSkillSource(input)).toEqual(expected);
  });

  it.each([
    "file:///etc/passwd",
    "https://evil.example/a/b",
    "../x@y",
    "a/b@../c",
    "https://github.com/a/b/tree/main/../../x",
    "",
  ])("rejects source %s", (input) => {
    expect(() => parseSkillSource(input)).toThrow();
  });

  function fakeGitHub(
    files: Record<string, string>,
    extra: { mode?: Record<string, string> } = {},
  ) {
    const requests: string[] = [];
    const fetcher: SkillFetch = async (url) => {
      requests.push(url);
      const parsed = new URL(url);
      if (parsed.hostname === "api.github.com")
        return {
          status: 200,
          truncated: false,
          text: JSON.stringify({
            truncated: false,
            tree: Object.entries(files).map(([file, content]) => ({
              path: file,
              type: "blob",
              mode: extra.mode?.[file] ?? "100644",
              size: content.length,
            })),
          }),
        };
      if (parsed.hostname === "raw.githubusercontent.com") {
        const file = decodeURIComponent(
          parsed.pathname.split("/").slice(4).join("/"),
        );
        return file in files
          ? { status: 200, truncated: false, text: files[file]! }
          : { status: 404, truncated: false, text: "" };
      }
      if (parsed.hostname === "skills.sh")
        return {
          status: 200,
          truncated: false,
          text: JSON.stringify({
            skills: [
              {
                source: "obra/superpowers",
                skillId: "brainstorming",
                name: "brainstorming",
                installs: 5,
              },
              { source: "open.feishu.cn", skillId: "x", name: "x" },
            ],
          }),
        };
      throw new Error(`unexpected ${url}`);
    };
    return { fetcher, requests };
  }

  it("installs SKILL.md with text references and skips scripts and symlinks", async () => {
    const { installer, skills, dir } = setup();
    const { fetcher, requests } = fakeGitHub(
      {
        "README.md": "repo",
        "skills/brainstorming/SKILL.md": skillMd("brainstorming"),
        "skills/brainstorming/references/questions.md": "Ask why.",
        "skills/brainstorming/scripts/run.py": "import os",
        "skills/brainstorming/link.md": "../../README.md",
        "skills/other/SKILL.md": skillMd("other"),
      },
      { mode: { "skills/brainstorming/link.md": "120000" } },
    );
    installer.useFetch(fetcher);
    const result = await installer.install("obra/superpowers@brainstorming");
    expect(result.skill).toMatchObject({
      name: "brainstorming",
      enabled: true,
      source: "github:obra/superpowers@brainstorming",
      files: ["references/questions.md"],
    });
    expect(result.skipped.sort()).toEqual(["link.md", "scripts/run.py"]);
    expect(result.warnings.join(" ")).toMatch(/Scripts/);
    expect(fs.existsSync(path.join(dir, "brainstorming", "scripts"))).toBe(
      false,
    );
    expect(
      skills.read("brainstorming", "references/questions.md").content,
    ).toBe("Ask why.");
    expect(
      requests.every((url) =>
        /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//.test(url),
      ),
    ).toBe(true);
    // Updating from the same source replaces it without asking.
    expect(
      (await installer.install("obra/superpowers@brainstorming")).replaced,
    ).toBe(true);
  });

  it("asks which skill when a repository holds several, and refuses invalid ones", async () => {
    const { installer } = setup();
    installer.useFetch(
      fakeGitHub({
        "a/SKILL.md": skillMd("a"),
        "b/SKILL.md": "---\nname: B\ndescription: x\n---\n",
      }).fetcher,
    );
    await expect(installer.install("o/r")).rejects.toThrow(/2 vaardigheden/);
    await expect(installer.install("o/r@b")).rejects.toThrow(
      /Ongeldige SKILL.md/,
    );
    await expect(installer.install("o/r@c")).rejects.toThrow(/niet gevonden/);
    expect((await installer.install("o/r@a")).skill.name).toBe("a");
  });

  it("does not overwrite a skill from another source without replace", async () => {
    const { installer, dir } = setup();
    place(dir, "a");
    installer.useFetch(fakeGitHub({ "a/SKILL.md": skillMd("a") }).fetcher);
    await expect(installer.install("o/r@a")).rejects.toThrow(
      /al een vaardigheid/,
    );
    expect((await installer.install("o/r@a", { replace: true })).replaced).toBe(
      true,
    );
  });

  it("searches skills.sh and keeps only GitHub sources", async () => {
    const { installer } = setup();
    installer.useFetch(fakeGitHub({}).fetcher);
    const result = await installer.search("brainstorm");
    expect(result.origin).toBe("skills.sh");
    expect(result.results.map((item) => item.install)).toEqual([
      "obra/superpowers@brainstorming",
    ]);
    installer.useFetch(async () => {
      throw new Error("offline");
    });
    const fallback = await installer.search("teksten mails");
    expect(fallback.origin).toBe("suggestions");
    expect(fallback.results.length).toBeGreaterThan(0);
  });

  it("exposes the tools and reports errors as text", async () => {
    const { skills, installer, dir } = setup();
    const source = new AgentSkillsSource(skills, installer);
    expect(
      source.definitions().find((tool) => tool.name === "skill_read")?.enabled,
    ).toBe(false);
    place(dir, "writing");
    expect(
      source.definitions().find((tool) => tool.name === "skill_read")?.enabled,
    ).toBe(true);
    const call = { sessionId: "s", signal: new AbortController().signal };
    expect(
      await source.execute("skill_read", { name: "nope" }, call),
    ).toMatchObject({ ok: false });
    expect(
      await source.execute("skill_read", { name: "writing" }, call),
    ).toMatchObject({
      ok: true,
      result: { untrusted: true },
    });
  });
});
