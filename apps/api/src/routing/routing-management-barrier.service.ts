import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NovaConfig } from "../core/config/nova-config.js";
import { RoutingService, type RoutingStatus } from "./routing.service.js";

export interface RoutingManagementOperation {
  block(reason: "account_change" | "policy_change"): void;
  releaseAfterVerification(): RoutingStatus;
}

/** Durable inference stop for management changes spanning multiple stores. */
@Injectable()
export class RoutingManagementBarrier {
  private owner: object | undefined;

  /** One management operation per NOVA process; failed operations retain the disk stop. */
  async run<T>(
    callback: (operation: RoutingManagementOperation) => Promise<T>,
  ): Promise<T> {
    if (this.owner)
      throw new Error("Routing management is already in progress");
    const owner = {};
    this.owner = owner;
    const assertOwner = () => {
      if (this.owner !== owner)
        throw new Error("Routing management operation has ended");
    };
    try {
      return await callback({
        block: (reason) => {
          assertOwner();
          this.block(reason);
        },
        releaseAfterVerification: () => {
          assertOwner();
          return this.releaseAfterVerification();
        },
      });
    } finally {
      this.owner = undefined;
    }
  }

  constructor(
    private readonly config: NovaConfig,
    private readonly routing: RoutingService,
  ) {}

  private get filename(): string {
    return this.config.dataFile("free-routing-management-block.json");
  }

  private syncDirectory(): void {
    const descriptor = fs.openSync(path.dirname(this.filename), "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }

  /** Call before the first upstream write; failure must prevent that write. */
  private block(reason: "account_change" | "policy_change"): void {
    if (reason !== "account_change" && reason !== "policy_change")
      throw new Error("Invalid routing management reason");
    this.routing.setManagementBlocked(true);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(
        descriptor,
        JSON.stringify({ version: 1, reason, createdAt: Date.now() }),
      );
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filename);
      this.syncDirectory();
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  /** Read native persistence afresh. Verification failure leaves the barrier in place. */
  private releaseAfterVerification(): RoutingStatus {
    const status = this.routing.verifyForManagement();
    if (!status.ready || status.policyVerified !== true || !status.freeOnly)
      throw new Error("Free-only routing remains unverified");
    try {
      fs.unlinkSync(this.filename);
      this.syncDirectory();
    } catch (error) {
      // If directory durability failed after unlink, re-establish the inference stop.
      this.block("policy_change");
      throw error;
    }
    this.routing.setManagementBlocked(false);
    return status;
  }
}
