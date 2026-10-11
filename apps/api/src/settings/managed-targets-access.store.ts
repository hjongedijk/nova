import { Injectable } from "@nestjs/common";
import fs from "node:fs";
import path from "node:path";
import type { ManagedTargetsAccessPolicy } from "@nova/contracts";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";

const emptyPolicy = (): ManagedTargetsAccessPolicy => ({
  mode: "all",
  proxmoxNodeIds: [],
  proxmoxGuestIds: [],
  termixHostIds: [],
  pangolinSiteIds: [],
  pangolinResourceIds: [],
});

@Injectable()
export class ManagedTargetsAccessStore {
  private readonly file: string;
  private policy = emptyPolicy();

  constructor(config: NovaConfig) {
    this.file = config.dataFile("managed-targets-access.json");
    if (!fs.existsSync(this.file)) return;
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8")) as
        ManagedTargetsAccessPolicy | undefined;
      if (
        value &&
        (value.mode === "all" || value.mode === "allowlist") &&
        [
          "proxmoxNodeIds",
          "proxmoxGuestIds",
          "termixHostIds",
          "pangolinSiteIds",
          "pangolinResourceIds",
        ].every((key) => Array.isArray(value[key as keyof typeof value]))
      )
        this.policy = value;
      else this.policy = { ...emptyPolicy(), mode: "allowlist" };
    } catch {
      this.policy = { ...emptyPolicy(), mode: "allowlist" };
    }
  }

  get(): ManagedTargetsAccessPolicy {
    return structuredClone(this.policy);
  }

  allows(key: keyof Omit<ManagedTargetsAccessPolicy, "mode">, id: string) {
    return this.policy.mode === "all" || this.policy[key].includes(id);
  }

  allowsProxmoxGuest(node: string, vmid: number | string) {
    return (
      this.policy.mode === "all" ||
      this.policy.proxmoxNodeIds.includes(node) ||
      this.policy.proxmoxGuestIds.includes(`${node}/${vmid}`)
    );
  }

  set(value: unknown, known: Record<string, Set<string>>) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError(["Ongeldige doeltoegang."]);
    const input = value as Record<string, unknown>;
    const fields = [
      "mode",
      "proxmoxNodeIds",
      "proxmoxGuestIds",
      "termixHostIds",
      "pangolinSiteIds",
      "pangolinResourceIds",
    ] as const;
    if (
      Object.keys(input).some((key) => !fields.includes(key as never)) ||
      (input.mode !== "all" && input.mode !== "allowlist")
    )
      throw new ValidationError(["Ongeldige doeltoegang."]);
    const limits: Record<string, number> = {
      proxmoxNodeIds: 200,
      proxmoxGuestIds: 200,
      termixHostIds: 200,
      pangolinSiteIds: 200,
      pangolinResourceIds: 200,
    };
    const next = emptyPolicy();
    next.mode = input.mode;
    for (const key of fields.slice(1)) {
      const values = input[key];
      if (
        !Array.isArray(values) ||
        values.length > limits[key]! ||
        values.some((id) => typeof id !== "string" || !known[key]?.has(id)) ||
        new Set(values).size !== values.length
      )
        throw new ValidationError([
          "Kies alleen doelen uit het actuele, beschikbare overzicht.",
        ]);
      Object.assign(next, { [key]: [...values] as string[] });
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    this.policy = next;
    return this.get();
  }
}
