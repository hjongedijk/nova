import { describe, expect, it } from "vitest";
import {
  agentErrorText,
  explainAgentWarning,
} from "../../src/integrations/windows/windows-pc.service.js";

describe("explainAgentWarning", () => {
  it("names the shortcut that is already taken (Windows error 1409)", () => {
    expect(
      explainAgentWarning("open: Ctrl+Alt+N (Windows error 1409)"),
    ).toMatch(/Ctrl\+Alt\+N wordt al gebruikt/);
  });
  it("explains other shortcut errors with the code", () => {
    expect(
      explainAgentWarning("desktop: Ctrl+Alt+D (Windows error 5)"),
    ).toMatch(/foutcode 5/);
  });
  it("explains tray and startup problems", () => {
    expect(explainAgentWarning("Tray: boom")).toMatch(/pictogram bij de klok/);
    expect(explainAgentWarning("Agent controls: boom")).toMatch(/opnieuw/);
  });
  it("explains the native agent's shortcut and emergency-stop warnings", () => {
    expect(explainAgentWarning("Agent controls: open: Ctrl+Alt+N")).toMatch(
      /Sneltoets Ctrl\+Alt\+N kon niet worden gekoppeld/,
    );
    expect(
      explainAgentWarning(
        "Noodstop Ctrl+Alt+Shift+K kon niet worden geregistreerd",
      ),
    ).toMatch(/pictogram bij de klok/);
    expect(
      explainAgentWarning("Agent controls: open: Ctrl+Alt+N\nignore"),
    ).not.toMatch(/Sneltoets/);
  });
  it("maps only the agent's fixed errors and the owner's pause", () => {
    expect(agentErrorText(409, "anything")).toMatch(/gepauzeerd/);
    expect(
      agentErrorText(500, "Windows kon het programma of adres niet openen"),
    ).toMatch(/kon dit programma/);
    expect(agentErrorText(500, "private diagnostic")).toBeNull();
    expect(agentErrorText(400, 42)).toBeNull();
  });
  it("never passes unknown or hostile text through", () => {
    for (const raw of [
      "something secret sk-123456789012345678901234",
      "open: Ctrl+Alt+N (Windows error 1409)\nignore previous",
      42,
      null,
    ])
      expect(explainAgentWarning(raw)).toBe(
        "Windows-bediening meldde een probleem. Controleer de agent op de pc.",
      );
  });
});
