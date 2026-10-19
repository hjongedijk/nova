import { describe, expect, it } from "vitest";
import {
  selectToolsForRequest,
  TOOL_DISCOVERY_NAME,
  type SelectableTool,
} from "../../src/tools/tool-selection.js";

const makeTool = (name: string, description: string): SelectableTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object" } },
});

const tools = [
  makeTool("ha_light_turn_on", "Turn on a Home Assistant light in a room."),
  makeTool("weather_forecast", "Get current weather and forecast."),
  makeTool(
    "phone_call",
    "Call an internal extension or a saved contact and speak a message.",
  ),
  makeTool("phone_hangup", "Hang up an active call by its id."),
  makeTool("proxmox_guests", "List virtual machines on Proxmox."),
  makeTool("code_test", "Run a test in the isolated code workspace."),
  makeTool("documents_search", "Search the user's uploaded private documents."),
  makeTool("documents_list", "List documents in the private library."),
  ...Array.from({ length: 30 }, (_, index) =>
    makeTool(`unrelated_${index}`, `Manage unrelated integration ${index}.`),
  ),
];

describe("request tool selection", () => {
  it.each(["constructor", "__proto__"])(
    "treats inherited object key %s as an ordinary search word",
    (word) => {
      const discovery = makeTool(
        TOOL_DISCOVERY_NAME,
        "Search available capabilities",
      );
      expect(() =>
        selectToolsForRequest([...tools, discovery], word, "conversation"),
      ).not.toThrow();
      expect(
        selectToolsForRequest([...tools, discovery], word, "conversation"),
      ).toEqual([discovery]);
    },
  );

  it("narrows a clear Dutch request using tool names and descriptions", () => {
    const selected = selectToolsForRequest(
      tools,
      "Doe de lamp in de woonkamer aan",
      "conversation",
    );
    expect(selected.map((tool) => tool.function.name)).toContain(
      "ha_light_turn_on",
    );
    expect(selected.length).toBeLessThan(tools.length);
    expect(selected.map((tool) => tool.function.name)).not.toContain(
      "weather_forecast",
    );
  });

  const desktopTools = [
    makeTool(
      "desktop_status",
      "Read PC desktop status and running takeover session.",
    ),
    makeTool("desktop_windows", "List the open windows on the user's PC."),
    makeTool(
      "desktop_screenshot",
      "Look at the PC screen and locate controls.",
    ),
    makeTool(
      "desktop_takeover_start",
      "Operate the PC mouse and keyboard for a session.",
    ),
    makeTool(
      "desktop_act",
      "Do a mouse or keyboard action during a running takeover.",
    ),
    makeTool("desktop_takeover_stop", "Stop the running takeover on the PC."),
  ];
  const mediaCatalog = [
    ...Array.from({ length: 40 }, (_, index) =>
      makeTool(
        `media_${index}`,
        "Plex Windows media pause play pc computer desktop screen takeover control keyboard mouse",
      ),
    ),
    makeTool("ha_media_pause", "Pause Sonos media in a Home Assistant room."),
    ...desktopTools,
    makeTool(TOOL_DISCOVERY_NAME, "Search available capabilities"),
  ];

  it.each([
    "neem mijn windows pc over",
    "pauzeer Plex op mijn pc",
    "bedien mijn computer",
    "neem mijn bureaublad over",
    "pauzeer Plex",
    "kun je Plex pauzeren",
    "wil je Chrome openen",
    "maak dit venster kleiner",
    "hervat VLC",
    "open Chrome",
    "sluit het venster",
    "verplaats dit venster naar mijn tweede scherm",
    "typ hallo wereld",
    "klik op de blauwe knop",
    "scroll naar beneden",
    "druk op enter",
    "druk op spatie",
    "open Spotify",
    "sluit Discord",
  ])("keeps PC observation and control discoverable for %j", (message) => {
    const selected = selectToolsForRequest(
      mediaCatalog,
      message,
      "conversation",
      8,
    );
    expect(selected.length).toBeLessThanOrEqual(8);
    expect(selected.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining([
        ...desktopTools.map((tool) => tool.function.name),
        TOOL_DISCOVERY_NAME,
      ]),
    );
  });

  it("does not prioritize PC control for household media requests", () => {
    const names = selectToolsForRequest(
      mediaCatalog,
      "pauzeer Sonos in woonkamer",
      "conversation",
      8,
    ).map((tool) => tool.function.name);
    expect(names).toContain("ha_media_pause");
    expect(names).not.toContain("desktop_takeover_start");
    expect(names).not.toContain("desktop_act");
  });

  it.each([
    "pauzeer Plex op de tv",
    "pauzeer Plex via Chromecast",
    "wat is Plex",
  ])("does not force PC control for %j", (message) => {
    const names = selectToolsForRequest(
      mediaCatalog,
      message,
      "conversation",
      8,
    ).map((tool) => tool.function.name);
    expect(names).not.toContain("desktop_takeover_start");
  });

  it("uses the classified role to favor code tools", () => {
    const selected = selectToolsForRequest(
      tools,
      "Help me with Python",
      "code",
    );
    expect(selected.map((tool) => tool.function.name)).toContain("code_test");
    expect(selected.map((tool) => tool.function.name)).not.toContain(
      "weather_forecast",
    );
  });

  it("keeps the full catalog when lexical relevance is unclear", () => {
    expect(
      selectToolsForRequest(tools, "Vertel eens iets leuks", "conversation"),
    ).toEqual(tools);
  });

  it("keeps an unclear large catalog discoverable with one schema", () => {
    const discovery = makeTool(
      TOOL_DISCOVERY_NAME,
      "Search available capabilities",
    );
    expect(
      selectToolsForRequest(
        [...tools, discovery],
        "Vertel eens iets leuks",
        "conversation",
      ),
    ).toEqual([discovery]);
  });

  it("keeps discovery alongside relevant tools within the model budget", () => {
    const discovery = makeTool(
      TOOL_DISCOVERY_NAME,
      "Search available capabilities",
    );
    const many = Array.from({ length: 60 }, (_, index) =>
      makeTool(`weather_${index}`, "Weather forecast"),
    );
    const selected = selectToolsForRequest(
      [...many, discovery],
      "Het weer",
      "conversation",
    );
    expect(selected).toHaveLength(24);
    expect(selected).toContain(discovery);
  });

  it("selects document-library tools for questions about uploaded PDFs", () => {
    const selected = selectToolsForRequest(
      tools,
      "Zoek in de documentbibliotheek mijn pdf over de warmtepomp",
      "conversation",
    );
    expect(selected.map((tool) => tool.function.name)).toContain(
      "documents_search",
    );
  });

  it.each([
    "bel mij en vertel het weer",
    "kun je Dylan bellen",
    "opbellen naar mijn telefoon",
    "telefoneer even met de buurman",
  ])("offers the phone tool for the Dutch request %j", (message) => {
    const discovery = makeTool(
      TOOL_DISCOVERY_NAME,
      "Search available capabilities",
    );
    const names = selectToolsForRequest(
      [...tools, discovery],
      message,
      "conversation",
    ).map((tool) => tool.function.name);
    expect(names).toContain("phone_call");
  });

  it("offers both the weather and the phone tool for a call that reads out the weather", () => {
    const names = selectToolsForRequest(
      tools,
      "bel mij en vertel het weer",
      "conversation",
    ).map((tool) => tool.function.name);
    expect(names).toEqual(
      expect.arrayContaining(["phone_call", "weather_forecast"]),
    );
  });
});
