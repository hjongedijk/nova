import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeSettingGroup } from "@nova/contracts";
import { NovaConfig } from "../../core/config/nova-config.js";
import { AuditService } from "../../core/audit/audit.service.js";
import { ValidationError } from "../../core/errors/validation.error.js";
import {
  RUNTIME_GROUPS,
  environmentDefault,
  applyRuntimeOverrides,
  normalizeRuntime,
  readRuntime,
  runtimeFile,
  runtimeGroup,
  type RuntimeValues,
} from "../../core/config/runtime-settings.js";

@Controller("settings/runtime")
export class RuntimeSettingsController {
  constructor(
    private readonly config: NovaConfig,
    private readonly audit: AuditService,
  ) {}

  @Get() list(): { groups: RuntimeSettingGroup[] } {
    return { groups: this.view() };
  }

  /** `values` are saved; a blank secret keeps its value; `reset` returns fields to the .env default. */
  @Put(":id") save(
    @Param("id") id: string,
    @Body() body: { values?: unknown; reset?: unknown } | undefined,
  ) {
    const group = runtimeGroup(id);
    const values = normalizeRuntime(id, body?.values ?? {});
    const reset = Array.isArray(body?.reset) ? body.reset : [];
    if (
      reset.some(
        (key) =>
          typeof key !== "string" ||
          !group.fields.some((field) => field.key === key),
      )
    )
      throw new ValidationError(["Onbekend veld."]);
    const data = readRuntime(this.config.dataDir);
    const saved: RuntimeValues = { ...data.groups[id] };
    for (const field of group.fields) {
      if (reset.includes(field.key)) delete saved[field.key];
      else if (Object.hasOwn(values, field.key)) {
        if (field.kind === "secret" && values[field.key] === "") continue;
        saved[field.key] = values[field.key]!;
      }
    }
    data.groups[id] = saved;
    this.audit.record({
      sessionId: "settings",
      tool: "settings_runtime_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { group: id, fields: Object.keys(values).concat(reset) },
      phase: "attempt",
    });
    const file = runtimeFile(this.config.dataDir),
      temporary = `${file}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      fs.writeFileSync(temporary, JSON.stringify(data, null, 2), {
        mode: 0o600,
      });
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    // Most consumers read shared config per call. The cached embedding backend
    // adopts model/dimension changes at restart; the UI states that explicitly.
    applyRuntimeOverrides(this.config);
    return { groups: this.view() };
  }

  private view(): RuntimeSettingGroup[] {
    const stored = readRuntime(this.config.dataDir).groups;
    return RUNTIME_GROUPS.map((group) => ({
      id: group.id,
      label: group.label,
      fields: group.fields.map((field) => {
        const own = stored[group.id]?.[field.key];
        const fromSettings = own !== undefined && own !== "";
        const env = environmentDefault(this.config, group.id, field.key);
        const current = fromSettings ? own : env;
        return {
          key: field.key,
          label: field.label,
          kind: field.kind,
          ...(field.choices ? { choices: field.choices } : {}),
          ...(field.hint ? { hint: field.hint } : {}),
          source: fromSettings
            ? ("settings" as const)
            : env
              ? ("environment" as const)
              : ("default" as const),
          configured: current !== "" && current !== undefined,
          ...(field.kind !== "secret" && current !== undefined
            ? {
                value:
                  field.kind === "boolean" && typeof current === "string"
                    ? current.toLowerCase() === "true"
                    : current,
              }
            : {}),
        };
      }),
    }));
  }
}
