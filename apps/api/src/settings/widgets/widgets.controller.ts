import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import type { ButtonPress, Widget, WidgetData } from "@nova/contracts";
import { AuditService } from "../../core/audit/audit.service.js";
import { runSkill } from "../skills/run-skill.js";
import {
  type StoredSkill,
  type StoredWebhookSkill,
  toolNameFor,
} from "../skills/skills.js";
import { SettingsStore } from "../store/settings.store.js";
import { WidgetDataService } from "./widget-data.service.js";

/**
 * What the screen needs from the user's own sidebar panels: their live data, and what a button
 * press does. Data comes from the server so web addresses stay hidden and are fetched with the
 * usual address checks.
 */
@Controller("widgets")
export class WidgetsController {
  constructor(
    private readonly settings: SettingsStore,
    private readonly data: WidgetDataService,
    private readonly audit: AuditService,
  ) {}

  @Get("data")
  async liveData(): Promise<Record<string, WidgetData>> {
    const live = (this.settings.get().widgets as unknown as Widget[]).filter(
      (widget): widget is Extract<Widget, { type: "value" | "list" }> =>
        widget.enabled && "source" in widget,
    );
    const entries = await Promise.all(
      live.map(
        async (widget) => [widget.id, await this.data.get(widget)] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  @Post(":id/press")
  @HttpCode(200)
  async press(
    @Param("id") id: string,
    @Body() body: { index?: unknown } | undefined,
    @Headers("x-nova-admin") admin: string | undefined,
  ): Promise<ButtonPress> {
    if (admin !== "1") throw new ForbiddenException("Alleen via het scherm.");
    const settings = this.settings.get();
    const widget = (settings.widgets as unknown as Widget[]).find(
      (item) => item.id === id && item.enabled,
    );
    const button =
      widget?.type === "buttons"
        ? widget.buttons[Number(body?.index)]
        : undefined;
    if (!button) throw new NotFoundException("Knop niet gevonden.");
    if (button.action === "ask")
      return { action: "ask", prompt: button.prompt };
    if (button.action === "link") return { action: "link", url: button.url };
    const skill = (settings.skills as unknown as StoredSkill[]).find(
      (item): item is StoredWebhookSkill =>
        item.id === button.skillId && item.enabled && item.type === "webhook",
    );
    if (!skill)
      throw new NotFoundException(
        "De vaardigheid achter deze knop staat uit of bestaat niet.",
      );
    // Anything that changes things goes through NOVA's confirmation flow instead of running here.
    if (!["READ_ONLY", "SAFE"].includes(skill.risk))
      return {
        action: "ask",
        prompt: `Voer de vaardigheid “${skill.name}” uit${
          Object.keys(button.args).length
            ? ` met ${JSON.stringify(button.args)}`
            : ""
        }.`,
      };
    const outcome = await runSkill(skill, button.args);
    this.audit.record({
      sessionId: "sidebar",
      tool: toolNameFor(skill),
      risk: skill.risk,
      confirmation: "sidebar_button",
      arguments: button.args,
      result: { ok: outcome.ok },
    });
    const response = outcome.result?.response;
    return {
      action: "ran",
      ok: outcome.ok,
      message: outcome.ok
        ? typeof response === "string"
          ? response.slice(0, 200)
          : "Gedaan."
        : outcome.error || "Dat is niet gelukt.",
    };
  }
}
