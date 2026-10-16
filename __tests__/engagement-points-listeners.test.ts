/**
 * ETAP 9.4 — the CRM listeners that feed the ledger (purchase, optional
 * comment points), module registration, and the "rf_" refs that must not
 * create a "havola:" tag.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../lib/engagement/worker", () => ({
  registerEngagementJobHandler: vi.fn(),
  registerEngagementMaintenanceTask: vi.fn(),
}));

import { applyAutomationTags } from "../lib/crm/tags";
import { clearCrmListeners, emitCrmEvent } from "../lib/crm/hooks";
import { saveSettings } from "../lib/engagement/settings";
import { registerEngagementJobHandler, registerEngagementMaintenanceTask } from "../lib/engagement/worker";
import { REFERRAL_REWARD_JOB } from "../lib/engagement/queue";
import { registerEngagementReferralModule } from "../lib/engagement/referral/module";
import { db, resetDb } from "./helpers/db-instance";

const contact = () => db.rows("crmContact").find((c) => c.id === "c1")! as never;
const points = () => db.rows("engagementPoint");

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  db.seed("crmContact", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u_1", username: "ali" });
}

beforeEach(() => {
  resetDb();
  clearCrmListeners();
  seed();
  registerEngagementReferralModule();
  delete process.env.ENGAGEMENT_DISABLED;
});
afterEach(() => {
  delete process.env.ENGAGEMENT_DISABLED;
});

const won = (dealId = "d1") =>
  emitCrmEvent({
    kind: "stage_changed", workspaceId: "w1", contactId: "c1", contact: contact(), dealId, fromStageId: null, toStageId: "s_won",
    stageKind: "WON", actor: { kind: "OPERATOR" },
  });

const comment = (eventId = "e1") =>
  emitCrmEvent({
    kind: "interaction", workspaceId: "w1", contactId: "c1", contact: contact(), direction: "inbound", via: "reconcile",
    at: new Date("2026-10-16T09:00:00Z"), payload: { eventType: "COMMENT", eventId },
  });

describe("module registration", () => {
  it("registers the maintenance task and the reward job handler through the engagement worker", () => {
    expect(registerEngagementMaintenanceTask).toHaveBeenCalledWith("referral", expect.any(Function));
    expect(registerEngagementJobHandler).toHaveBeenCalledWith(REFERRAL_REWARD_JOB, expect.any(Function));
  });

  it("registering twice does not double the listener", async () => {
    registerEngagementReferralModule();
    registerEngagementReferralModule();
    await won();
    expect(points()).toHaveLength(1);
  });
});

describe("purchase points", () => {
  it("a WON stage awards the purchase points once per deal, even if the event is replayed", async () => {
    await won("d1");
    await won("d1");
    expect(points()).toHaveLength(1);
    expect(points()[0]).toMatchObject({ contactId: "c1", points: 20, reason: "purchase", sourceTable: "CrmDeal", sourceId: "d1" });
    await won("d2");
    expect(points()).toHaveLength(2);
  });

  it("a stage that is not WON awards nothing", async () => {
    await emitCrmEvent({
      kind: "stage_changed", workspaceId: "w1", contactId: "c1", contact: contact(), dealId: "d1", fromStageId: null, toStageId: "s",
      stageKind: "LOST", actor: { kind: "OPERATOR" },
    });
    expect(points()).toHaveLength(0);
  });

  it("is a no-op under ENGAGEMENT_DISABLED", async () => {
    process.env.ENGAGEMENT_DISABLED = "1";
    await won();
    expect(points()).toHaveLength(0);
  });
});

describe("comment points", () => {
  it("are off by default", async () => {
    await comment();
    expect(points()).toHaveLength(0);
  });

  it("are awarded once per comment when the owner turns them on, with the configured amount", async () => {
    await saveSettings("w1", { pointsRules: { comment: { points: 2, enabled: true } } });
    await comment("e1");
    await comment("e1");
    await comment("e2");
    expect(points()).toHaveLength(2);
    expect(points()[0]).toMatchObject({ points: 2, reason: "comment", sourceTable: "InstagramEvent", sourceId: "e1" });
  });

  it("ignores interactions that are not comments", async () => {
    await saveSettings("w1", { pointsRules: { comment: { points: 2, enabled: true } } });
    await emitCrmEvent({
      kind: "interaction", workspaceId: "w1", contactId: "c1", contact: contact(), direction: "inbound", via: "reconcile",
      at: new Date(), payload: { eventType: "DIRECT_MESSAGE", eventId: "e5" },
    });
    expect(points()).toHaveLength(0);
  });
});

describe("rf_ refs and the havola tag", () => {
  it("a referral ref creates no havola: tag, a campaign ref still does", async () => {
    await applyAutomationTags("w1", "c1", { ref: "rf_AB23CD" });
    await applyAutomationTags("w1", "c1", { ref: "RF_ab23cd" });
    expect(db.rows("crmTag")).toHaveLength(0);
    expect(db.rows("crmContactTag")).toHaveLength(0);

    await applyAutomationTags("w1", "c1", { ref: "yozgi-aksiya" });
    expect(db.rows("crmTag").map((t) => t.slug)).toEqual(["havola:yozgi-aksiya"]);
  });
});
