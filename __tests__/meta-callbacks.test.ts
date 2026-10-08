import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});

import { POST as dataDeletion } from "../app/api/instagram/data-deletion/route";
import { POST as deauthorize } from "../app/api/instagram/deauthorize/route";
import { parseSignedRequest } from "../lib/meta/signed-request";
import { db, resetDb } from "./helpers/db-instance";

const SECRET = "test-instagram-secret";

function sign(payload: Record<string, unknown>, secret = SECRET): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${sig}.${body}`;
}

function callback(signedRequest: string): Request {
  return new Request("https://socialauto.uz/api/instagram/x", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ signed_request: signedRequest }).toString(),
  });
}

beforeEach(() => {
  resetDb();
  process.env.INSTAGRAM_APP_SECRET = SECRET;
  process.env.FACEBOOK_APP_SECRET = "";
  process.env.NEXTAUTH_URL = "https://socialauto.uz";
  db.seed("workspace", { id: "w1" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", instagramId: "17841", username: "shop", name: "Shop", accessToken: "enc", tokenStatus: "ACTIVE", webhookSubscribed: true });
  db.seed("instagramAccount", { id: "a2", workspaceId: "w1", instagramId: "99999", username: "other", accessToken: "enc2", tokenStatus: "ACTIVE" });
  db.seed("automation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", name: "Kampaniya" });
  db.seed("conversation", { id: "conv1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1" });
  db.seed("followerSnapshot", { id: "f1", instagramAccountId: "a1", followersCount: 10 });
});

describe("signed_request", () => {
  it("accepts a correctly signed payload and rejects a forged one", () => {
    expect(parseSignedRequest(sign({ algorithm: "HMAC-SHA256", user_id: "17841" }), [SECRET])).toMatchObject({ user_id: "17841" });
    expect(parseSignedRequest(sign({ user_id: "17841" }, "wrong-secret"), [SECRET])).toBeNull();
    expect(parseSignedRequest("garbage", [SECRET])).toBeNull();
  });
});

describe("deauthorize callback", () => {
  it("disconnects only that Instagram account and keeps the workspace data", async () => {
    const res = await deauthorize(callback(sign({ algorithm: "HMAC-SHA256", user_id: "17841" })));
    expect(res.status).toBe(200);
    const [a1, a2] = db.rows("instagramAccount");
    expect(a1).toMatchObject({ accessToken: "", tokenStatus: "BROKEN", webhookSubscribed: false });
    expect(a2).toMatchObject({ accessToken: "enc2", tokenStatus: "ACTIVE" });
    expect(db.rows("automation")).toHaveLength(1);
    expect(db.rows("conversation")).toHaveLength(1);
  });

  it("rejects an unsigned request", async () => {
    const res = await deauthorize(callback(sign({ user_id: "17841" }, "forged")));
    expect(res.status).toBe(400);
    expect(db.rows("instagramAccount")[0].accessToken).toBe("enc");
  });
});

describe("data deletion callback", () => {
  it("deletes the account's Instagram data and returns Meta's status URL and code", async () => {
    const res = await dataDeletion(callback(sign({ algorithm: "HMAC-SHA256", user_id: "17841", issued_at: 1700000000 })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; confirmation_code: string };
    expect(body.confirmation_code).toMatch(/^[A-F0-9]{16}$/);
    expect(body.url).toBe(`https://socialauto.uz/data-deletion?code=${body.confirmation_code}`);

    expect(db.rows("conversation")).toHaveLength(0);
    expect(db.rows("followerSnapshot")).toHaveLength(0);
    expect(db.rows("instagramAccount")[0]).toMatchObject({ accessToken: "", tokenStatus: "BROKEN", name: null });
    // The workspace's own campaign stays, as with the in-app disconnect.
    expect(db.rows("automation")).toHaveLength(1);
  });
});
