import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  normalizeNodeRedBackupFlows,
  type NodeRedFlowSnapshot,
  type NodeRedManagement,
} from "./node-red-management.service.js";

const MAX_REVISIONS = 20;
const MAX_FILE_BYTES = 20 * 800_000 + 20_000;

type StoredRevision = {
  id: string;
  at: string;
  snapshot: NodeRedFlowSnapshot;
};

export type NodeRedFlowRevisionMetadata = {
  id: string;
  at: string;
  nodeCount: number;
};

/** Private snapshots. Public callers receive only IDs, dates and node counts. */
@Injectable()
export class NodeRedFlowRevisions {
  private readonly file: string;
  private readonly fingerprintKey = crypto.randomBytes(32);

  constructor(@Inject(NovaConfig) config: Pick<NovaConfig, "dataFile">) {
    this.file = config.dataFile("node-red-flow-revisions.json");
  }

  private read(): StoredRevision[] {
    if (!fs.existsSync(this.file)) return [];
    const stat = fs.statSync(this.file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES)
      throw new Error("Node-RED-flowgeschiedenis is ongeldig.");
    const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
    if (!Array.isArray(value) || value.length > MAX_REVISIONS)
      throw new Error("Node-RED-flowgeschiedenis is ongeldig.");
    return value.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item))
        throw new Error("Node-RED-flowgeschiedenis is ongeldig.");
      const row = item as Record<string, unknown>;
      const snapshot = row.snapshot as Record<string, unknown> | undefined;
      if (
        typeof row.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(row.id) ||
        typeof row.at !== "string" ||
        !Number.isFinite(Date.parse(row.at)) ||
        !snapshot ||
        typeof snapshot.revision !== "string" ||
        !snapshot.revision ||
        snapshot.revision.length > 256
      )
        throw new Error("Node-RED-flowgeschiedenis is ongeldig.");
      return {
        id: row.id,
        at: new Date(row.at).toISOString(),
        snapshot: {
          revision: snapshot.revision,
          flows: normalizeNodeRedBackupFlows(snapshot.flows),
        },
      };
    });
  }

  private write(rows: StoredRevision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(rows.slice(-MAX_REVISIONS)), {
        mode: 0o600,
        flag: "wx",
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  list(): { revisions: NodeRedFlowRevisionMetadata[]; truncated: boolean } {
    const rows = this.read();
    return {
      revisions: rows
        .slice(-10)
        .reverse()
        .map(({ id, at, snapshot }) => ({
          id,
          at,
          nodeCount: snapshot.flows.length,
        })),
      truncated: rows.length > 10,
    };
  }

  /** Record a verified live snapshot after a successful flow change. */
  record(snapshot: NodeRedFlowSnapshot): NodeRedFlowRevisionMetadata {
    if (
      typeof snapshot.revision !== "string" ||
      !snapshot.revision ||
      snapshot.revision.length > 256
    )
      throw new Error("Ongeldige Node-RED-flowrevisie.");
    const flows = normalizeNodeRedBackupFlows(snapshot.flows);
    const rows = this.read();
    const latest = rows.at(-1);
    if (latest?.snapshot.revision === snapshot.revision) {
      if (!isDeepStrictEqual(latest.snapshot.flows, flows))
        throw new ConflictException(
          "Dezelfde Node-RED-revisie bevat andere flows.",
        );
      return {
        id: latest.id,
        at: latest.at,
        nodeCount: latest.snapshot.flows.length,
      };
    }
    const row: StoredRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      snapshot: { revision: snapshot.revision, flows },
    };
    this.write([...rows, row]);
    return { id: row.id, at: row.at, nodeCount: flows.length };
  }

  /** Called only after the upstream write has been independently verified. */
  recordVerifiedChange(
    before: { revision: string; flows: unknown },
    after: { revision: string; flows: unknown },
  ): void {
    if (before.revision === after.revision)
      throw new ConflictException("Node-RED-flowrevisie is niet gewijzigd.");
    // Validate both before saving either revision; a rejected live snapshot never
    // leaves a misleading half-history.
    const beforeFlows = normalizeNodeRedBackupFlows(before.flows);
    const afterFlows = normalizeNodeRedBackupFlows(after.flows);
    this.record({ revision: before.revision, flows: beforeFlows });
    this.record({ revision: after.revision, flows: afterFlows });
  }

  /** A content-bound confirmation token without exposing saved flow nodes. */
  prepareRestore(id: string, live: NodeRedFlowSnapshot): string {
    const rows = this.read();
    const target = rows.find((row) => row.id === id);
    if (!target) throw new NotFoundException("Flowversie niet beschikbaar.");
    if (live.revision !== rows.at(-1)?.snapshot.revision)
      throw new ConflictException("Node-RED-flows zijn later gewijzigd.");
    if (isDeepStrictEqual(live.flows, target.snapshot.flows))
      throw new ConflictException("Deze flowversie is al actief.");
    return this.restoreFingerprint(target, live.revision);
  }

  private restoreFingerprint(
    target: StoredRevision,
    liveRevision: string,
  ): string {
    return crypto
      .createHmac("sha256", this.fingerprintKey)
      .update(
        JSON.stringify({
          id: target.id,
          liveRevision,
          flows: target.snapshot.flows,
        }),
      )
      .digest("hex");
  }

  /** Restore only while the current live revision matches the last recorded one. */
  async restore(
    id: string,
    expectedFingerprint: string,
    management: Pick<NodeRedManagement, "flowSnapshot" | "writeFlowSnapshot">,
  ): Promise<NodeRedFlowRevisionMetadata & { historyWarning?: string }> {
    const rows = this.read();
    const target = rows.find((row) => row.id === id);
    if (!target) throw new NotFoundException("Flowversie niet beschikbaar.");
    const live = await management.flowSnapshot();
    if (live.revision !== rows.at(-1)?.snapshot.revision)
      throw new ConflictException("Node-RED-flows zijn later gewijzigd.");
    if (
      !/^[0-9a-f]{64}$/.test(expectedFingerprint) ||
      this.restoreFingerprint(target, live.revision) !== expectedFingerprint
    )
      throw new ConflictException("Flowversie is na voorbereiding gewijzigd.");
    const result = await management.writeFlowSnapshot(
      live.revision,
      target.snapshot.flows,
    );
    if (!result.ok || !result.revision)
      throw new ConflictException("Flowversie kon niet worden hersteld.");
    let restored: NodeRedFlowSnapshot;
    try {
      restored = await management.flowSnapshot();
    } catch {
      return {
        id: target.id,
        at: new Date().toISOString(),
        nodeCount: target.snapshot.flows.length,
        historyWarning:
          "Flow hersteld, maar lokale versiegeschiedenis kon niet worden opgeslagen.",
      };
    }
    if (
      restored.revision !== result.revision ||
      !isDeepStrictEqual(restored.flows, target.snapshot.flows)
    )
      throw new ConflictException("Flowherstel kon niet worden bevestigd.");
    try {
      return this.record(restored);
    } catch {
      return {
        id: target.id,
        at: new Date().toISOString(),
        nodeCount: restored.flows.length,
        historyWarning:
          "Flow hersteld, maar lokale versiegeschiedenis kon niet worden opgeslagen.",
      };
    }
  }
}
