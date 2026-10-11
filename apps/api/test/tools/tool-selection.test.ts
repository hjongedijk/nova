import { describe, expect, it } from "vitest";
import {
  selectToolsForRequest,
  type SelectableTool,
} from "../../src/tools/tool-selection.js";

const makeTool = (name: string, description: string): SelectableTool => ({
  type: "function",
  function: { name, description, parameters: { type: "object" } },
});

const tools = [
  makeTool("ha_light_turn_on", "Turn on a Home Assistant light in a room."),
  makeTool("weather_forecast", "Get current weather and forecast."),
  makeTool("proxmox_guests", "List virtual machines on Proxmox."),
  makeTool("code_test", "Run a test in the isolated code workspace."),
  makeTool("documents_search", "Search the user's uploaded private documents."),
  makeTool("documents_list", "List documents in the private library."),
  ...Array.from({ length: 30 }, (_, index) =>
    makeTool(`unrelated_${index}`, `Manage unrelated integration ${index}.`),
  ),
];

describe("request tool selection", () => {
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
});
