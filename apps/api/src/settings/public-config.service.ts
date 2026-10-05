import { Injectable } from "@nestjs/common";
import type { PublicConfig, Widget } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { publicOrigin } from "../core/public-url.js";
import { MAX_PAGES, resolveSidebar } from "./settings-validation.js";
import type { StoredSkill } from "./skills/skills.js";
import { SettingsStore } from "./store/settings.store.js";
import { publicWidget } from "./widgets/widgets.js";

/** What the home screen needs without any PIN: layout, panels, quick actions and examples. */
@Injectable()
export class PublicConfigService {
  constructor(
    private readonly settings: SettingsStore,
    private readonly config: NovaConfig,
  ) {}

  get(): PublicConfig {
    const settings = this.settings.get();
    const skills = settings.skills as unknown as StoredSkill[];
    return {
      publicUrl: publicOrigin(this.config.publicUrl),
      sidebar: resolveSidebar(settings),
      widgets: (settings.widgets as unknown as Widget[])
        .filter((widget) => widget.enabled)
        .map(publicWidget),
      maxPages: MAX_PAGES,
      quickActions: this.settings.quickActions(),
      skillExamples: skills
        .filter((skill) => skill.enabled && skill.examples.length)
        .map((skill) => ({ name: skill.name, examples: skill.examples })),
    };
  }
}
