import { Module } from "@nestjs/common";
import { SettingsStore } from "./settings.store.js";

/** The settings file on its own, so the tool registry can read it without the settings screen. */
@Module({ providers: [SettingsStore], exports: [SettingsStore] })
export class SettingsStoreModule {}
