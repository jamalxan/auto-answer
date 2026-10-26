/**
 * Audit 2026-10-26: test objects in a production workspace are listed and
 * deleted only while they still match the test rules.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import { deleteTestData, findTestData } from "@/lib/ops/test-data";

const WS = "ws1";

beforeEach(() => {
  resetDb();
  db.seed("triggerCampaign", { id: "t1", workspaceId: WS, kind: "CAMPAIGN", name: "TEST Claude (pauza)", active: false });
  db.seed("triggerCampaign", { id: "live", workspaceId: WS, kind: "CAMPAIGN", name: "Test chegirma", active: true });
  db.seed("triggerCampaign", { id: "real", workspaceId: WS, kind: "CAMPAIGN", name: "Narx", active: false });
  db.seed("triggerCampaign", { id: "other", workspaceId: "ws2", kind: "CAMPAIGN", name: "TEST", active: false });
  db.seed("flow", { id: "f1", workspaceId: WS, name: "test flow", publishedVersionId: null, proxyCampaignId: null });
  db.seed("flow", { id: "f2", workspaceId: WS, name: "TEST live", publishedVersionId: "v1", proxyCampaignId: null });
  db.seed("lead", { id: "l1", workspaceId: WS, isTest: true, name: "Sandbox" });
  db.seed("lead", { id: "l2", workspaceId: WS, isTest: false, name: "Real" });
});

describe("test data cleanup", () => {
  it("lists only switched-off TEST campaigns, unpublished TEST flows and test leads of this workspace", async () => {
    const items = await findTestData(WS);
    expect(items.map((i) => `${i.kind}:${i.id}`).sort()).toEqual(["campaign:t1", "flow:f1", "lead:l1"]);
  });

  it("never deletes something that stopped matching or belongs to someone else", async () => {
    db.rows("triggerCampaign").find((c) => c.id === "t1")!.active = true; // switched on after listing
    const result = await deleteTestData(WS, [
      { kind: "campaign", id: "t1" },
      { kind: "campaign", id: "real" },
      { kind: "campaign", id: "other" },
      { kind: "flow", id: "f1" },
      { kind: "lead", id: "l1" },
      { kind: "lead", id: "l2" },
    ]);
    expect(result).toEqual({ campaigns: 0, flows: 1, leads: 1 });
    expect(db.rows("triggerCampaign").map((c) => c.id).sort()).toEqual(["live", "other", "real", "t1"]);
    expect(db.rows("lead").map((l) => l.id)).toEqual(["l2"]);
  });
});
