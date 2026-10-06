import { changeObserved, locateTab, type Layout, type TabChange } from "../domain/workspace.js";

/** The external workspace operations required by verified tab use cases. */
export interface WorkspacePort {
  inspect(): Promise<Layout>;
  request(change: TabChange): Promise<void>;
}

/** A mutation receipt; acceptance alone is not evidence of completion. */
export interface MutationReceipt {
  status: "verified" | "unverified";
  change: TabChange;
  detail?: string;
}

/** Bounded observation policy with an injectable clock for deterministic tests. */
export interface ObservationPolicy {
  attempts: number;
  pause(): Promise<void>;
}

const defaultPolicy: ObservationPolicy = {
  attempts: 20,
  pause: () => new Promise((resolve) => setTimeout(resolve, 100)),
};

/** Tab mutations are issued once; only their public postconditions are retried. */
export class Workspace {
  constructor(private readonly port: WorkspacePort, private readonly policy = defaultPolicy) {
    if (!Number.isInteger(policy.attempts) || policy.attempts < 1) throw new Error("Observation attempts must be a positive integer");
  }

  inspect(): Promise<Layout> {
    return this.port.inspect();
  }

  /** A verified result requires the requested title, selection, or absence in a fresh snapshot. */
  async change(change: TabChange): Promise<MutationReceipt> {
    const before = await this.port.inspect();
    if (!locateTab(before, change.tabId)) throw new Error(`Tab not found: ${change.tabId}`);
    if (changeObserved(before, change)) return { status: "verified", change };
    await this.port.request(change);
    for (let attempt = 0; attempt < this.policy.attempts; attempt++) {
      if (attempt > 0) await this.policy.pause();
      let snapshot: Layout;
      try {
        snapshot = await this.port.inspect();
      } catch (error) {
        return { status: "unverified", change, detail: `Request sent; observation failed: ${String(error)}` };
      }
      if (changeObserved(snapshot, change)) return { status: "verified", change };
    }
    return { status: "unverified", change, detail: "Request sent; postcondition not observed. Do not blindly repeat destructive requests." };
  }
}
