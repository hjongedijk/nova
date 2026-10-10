import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import {
  RoutingManagementBarrier,
  type RoutingManagementOperation,
} from "../../src/routing/routing-management-barrier.service.js";
import {
  FreeRoutingBlockedError,
  RoutingService,
  type RoutingStatus,
} from "../../src/routing/routing.service.js";

const verified: RoutingStatus = {
  ready: true,
  freeOnly: true,
  policyVerified: true,
  status: "VERIFIED_FREE_ROUTE",
};

describe("durable routing management barrier", () => {
  let directory: string;
  let filename: string;
  let config: NovaConfig;
  let verify: ReturnType<typeof vi.fn<() => RoutingStatus>>;
  let barrier: RoutingManagementBarrier;
  let routing: RoutingService;

  const during =
    <T extends unknown[]>(
      body: (operation: RoutingManagementOperation, ...args: T) => unknown,
    ) =>
    (...args: T) =>
      barrier.run(async (operation) => {
        await body(operation, ...args);
      });

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-management-stop-"));
    filename = path.join(directory, "free-routing-management-block.json");
    config = {
      dataFile: (name: string) => path.join(directory, name),
      omniUrl: "http://fixture-gateway.invalid/v1",
      verifiedOmniUrl: "http://fixture-gateway.invalid/v1",
      freeOnly: false,
    } as NovaConfig;
    routing = new RoutingService(config);
    verify = vi.fn(() => ({ ...verified }));
    vi.spyOn(routing, "verifyForManagement").mockImplementation(verify);
    barrier = new RoutingManagementBarrier(config, routing);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const marker = () => JSON.parse(fs.readFileSync(filename, "utf8"));
  const expectClean = () =>
    expect(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);

  it.each(["account_change", "policy_change"] as const)(
    "stores only fixed private metadata for %s with mode 0600",
    during((operation, reason) => {
      const started = Date.now();
      operation.block(reason);
      const data = marker();
      expect(Object.keys(data).sort()).toEqual([
        "createdAt",
        "reason",
        "version",
      ]);
      expect(data).toMatchObject({ version: 1, reason });
      expect(data.createdAt).toBeGreaterThanOrEqual(started);
      expect(data.createdAt).toBeLessThanOrEqual(Date.now());
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(filename, "utf8")).not.toContain("private");
      expect(verify).not.toHaveBeenCalled();
      expectClean();
    }),
  );

  it(
    "keeps actual inference blocked across new service instances, before the test bypass",
    during(async (operation) => {
      const freshRouting = new RoutingService(config);
      expect(freshRouting.assertFree().ready).toBe(true);
      operation.block("account_change");
      for (const instance of [freshRouting, new RoutingService(config)]) {
        expect(instance.status()).toMatchObject({
          ready: false,
          freeOnly: true,
          policyVerified: false,
          status: "POLICY_CHANGE_PENDING",
        });
        expect(() => instance.assertFree()).toThrow(FreeRoutingBlockedError);
      }
      const restarted = new RoutingManagementBarrier(config, routing);
      expect(fs.existsSync(filename)).toBe(true);
      expect(
        await restarted.run(async (restartOperation) =>
          restartOperation.releaseAfterVerification(),
        ),
      ).toEqual(verified);
      expect(new RoutingService(config).assertFree().ready).toBe(true);
    }),
  );

  it.each([
    { ...verified, ready: false },
    { ...verified, freeOnly: false },
    { ...verified, policyVerified: false },
    { ...verified, policyVerified: undefined },
  ])(
    "never releases incomplete verification: %j",
    during((operation, status) => {
      operation.block("account_change");
      const before = fs.readFileSync(filename, "utf8");
      verify.mockReturnValue(status);
      expect(() => operation.releaseAfterVerification()).toThrow(
        "remains unverified",
      );
      expect(fs.readFileSync(filename, "utf8")).toBe(before);
      expect(verify).toHaveBeenCalledTimes(1);
      expectClean();
    }),
  );

  it("rejects overlapping operations before invoking another callback", async () => {
    let complete!: () => void;
    const waiting = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const first = barrier.run(async (operation) => {
      operation.block("account_change");
      await waiting;
    });
    const second = vi.fn(async () => undefined);
    try {
      await expect(barrier.run(second)).rejects.toThrow("already in progress");
      expect(second).not.toHaveBeenCalled();
      expect(routing.status().ready).toBe(false);
    } finally {
      complete();
      await first;
    }
    await barrier.run(async () => {
      expect(fs.existsSync(filename)).toBe(true);
    });
  });

  it("releases operation ownership after rejection while retaining its durable stop", async () => {
    await expect(
      barrier.run(async (operation) => {
        operation.block("account_change");
        throw new Error("fixture operation rejected");
      }),
    ).rejects.toThrow("fixture operation rejected");
    expect(routing.status().ready).toBe(false);
    expect(fs.existsSync(filename)).toBe(true);
    await barrier.run(async (operation) => {
      expect(operation.releaseAfterVerification()).toEqual(verified);
    });
    expect(routing.assertFree().ready).toBe(true);
  });

  it("rejects stale controls after completion and during a later operation", async () => {
    let stale!: RoutingManagementOperation;
    await barrier.run(async (operation) => {
      stale = operation;
    });
    const assertStale = () => {
      expect(() => stale.block("account_change")).toThrow(
        "operation has ended",
      );
      expect(() => stale.releaseAfterVerification()).toThrow(
        "operation has ended",
      );
    };
    assertStale();
    await barrier.run(async (operation) => {
      assertStale();
      operation.block("policy_change");
      expect(marker().reason).toBe("policy_change");
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it(
    "keeps the process latch blocked when release sync and restoration both fail",
    during((operation) => {
      operation.block("account_change");
      const originalSync = fs.fsyncSync;
      vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        if (fs.fstatSync(descriptor).isDirectory())
          throw new Error("fixture release sync failure");
        originalSync(descriptor);
      });
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
        throw new Error("fixture restore write failure");
      });
      expect(() => operation.releaseAfterVerification()).toThrow(
        "fixture restore write failure",
      );
      expect(fs.existsSync(filename)).toBe(false);
      expect(routing.status()).toMatchObject({
        ready: false,
        status: "POLICY_CHANGE_PENDING",
      });
      expect(() => routing.assertFree()).toThrow(FreeRoutingBlockedError);
      expectClean();
    }),
  );

  it(
    "retains the stop if fresh verification throws",
    during((operation) => {
      operation.block("account_change");
      verify.mockImplementation(() => {
        throw new Error("fixture verification unavailable");
      });
      expect(() => operation.releaseAfterVerification()).toThrow(
        "fixture verification unavailable",
      );
      expect(marker().reason).toBe("account_change");
      expectClean();
    }),
  );

  it(
    "reverifies afresh for every release rather than reusing prior success",
    during((operation) => {
      operation.block("account_change");
      expect(operation.releaseAfterVerification()).toEqual(verified);
      expect(fs.existsSync(filename)).toBe(false);
      operation.block("policy_change");
      verify.mockReturnValue({ ...verified, policyVerified: false });
      expect(() => operation.releaseAfterVerification()).toThrow(
        "remains unverified",
      );
      expect(fs.existsSync(filename)).toBe(true);
      verify.mockReturnValue({ ...verified });
      expect(operation.releaseAfterVerification()).toEqual(verified);
      expect(fs.existsSync(filename)).toBe(false);
      expect(verify).toHaveBeenCalledTimes(3);
      expectClean();
    }),
  );

  it.each(["write", "file-sync", "rename", "directory-sync"])(
    "keeps a durable stop and closes descriptors when %s fails",
    during((operation, failure) => {
      operation.block("account_change");
      const opened: number[] = [];
      const originalOpen = fs.openSync;
      vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
        const descriptor = originalOpen(file, flags, mode);
        opened.push(descriptor);
        return descriptor;
      });
      if (failure === "write")
        vi.spyOn(fs, "writeFileSync").mockImplementation(() => {
          throw new Error("fixture write failure");
        });
      if (failure === "rename")
        vi.spyOn(fs, "renameSync").mockImplementation(() => {
          throw new Error("fixture rename failure");
        });
      if (failure === "file-sync" || failure === "directory-sync") {
        const originalSync = fs.fsyncSync;
        vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
          const directoryDescriptor = fs.fstatSync(descriptor).isDirectory();
          if (directoryDescriptor === (failure === "directory-sync"))
            throw new Error("fixture sync failure");
          originalSync(descriptor);
        });
      }
      expect(() => operation.block("policy_change")).toThrow("fixture");
      expect(fs.existsSync(filename)).toBe(true);
      expect(new RoutingService(config).status().status).toBe(
        "POLICY_CHANGE_PENDING",
      );
      expectClean();
      expect(opened.length).toBeGreaterThan(0);
      for (const descriptor of opened)
        expect(() => fs.fstatSync(descriptor)).toThrow();
    }),
  );

  it(
    "reestablishes the barrier if unlink fails after positive verification",
    during((operation) => {
      operation.block("account_change");
      vi.spyOn(fs, "unlinkSync").mockImplementationOnce(() => {
        throw new Error("fixture unlink failure");
      });
      expect(() => operation.releaseAfterVerification()).toThrow(
        "fixture unlink failure",
      );
      expect(marker().reason).toBe("policy_change");
      expect(new RoutingService(config).status().ready).toBe(false);
      expectClean();
    }),
  );

  it(
    "reestablishes the barrier when directory sync fails after unlink",
    during((operation) => {
      operation.block("account_change");
      const originalSync = fs.fsyncSync;
      let failed = false;
      vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
        if (!failed && fs.fstatSync(descriptor).isDirectory()) {
          failed = true;
          throw new Error("fixture release sync failure");
        }
        originalSync(descriptor);
      });
      expect(() => operation.releaseAfterVerification()).toThrow(
        "fixture release sync failure",
      );
      expect(failed).toBe(true);
      expect(marker().reason).toBe("policy_change");
      expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
      expect(() => new RoutingService(config).assertFree()).toThrow(
        FreeRoutingBlockedError,
      );
      expectClean();
    }),
  );

  it(
    "replaces an existing symlink without modifying its private target",
    during((operation) => {
      const target = path.join(directory, "private-target.txt");
      fs.writeFileSync(target, "private-target-remains-unchanged", {
        mode: 0o600,
      });
      fs.symlinkSync(target, filename);
      expect(new RoutingService(config).status().status).toBe(
        "POLICY_CHANGE_PENDING",
      );
      operation.block("account_change");
      expect(fs.lstatSync(filename).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, "utf8")).toBe(
        "private-target-remains-unchanged",
      );
      expect(marker().reason).toBe("account_change");
      expectClean();
    }),
  );

  it(
    "blocks even a dangling symlink before policy lookup",
    during(() => {
      fs.symlinkSync(path.join(directory, "missing-target"), filename);
      expect(new RoutingService(config).status().status).toBe(
        "POLICY_CHANGE_PENDING",
      );
      expect(() => new RoutingService(config).assertFree()).toThrow(
        FreeRoutingBlockedError,
      );
    }),
  );

  it.each([
    "private-token",
    "account_change:private-token",
    "",
    null,
    {},
    undefined,
  ])(
    "rejects unknown runtime reasons before touching files: %j",
    during((operation, reason) => {
      expect(() => operation.block(reason as "account_change")).toThrow(
        "Invalid routing management reason",
      );
      expect(fs.readdirSync(directory)).toEqual([]);
      expect(verify).not.toHaveBeenCalled();
    }),
  );
});
