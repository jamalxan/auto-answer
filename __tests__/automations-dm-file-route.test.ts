/**
 * Campaign PATCH / DELETE and the attached file: the key must be a DM file of
 * the workspace, its type comes from the key, metadata only moves with the
 * file, and a replaced or deleted file is removed only when nothing else (a
 * duplicated campaign) still uses it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleted } = vi.hoisted(() => ({ deleted: [] as string[] }));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/content/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/content/storage")>()),
  getStorage: () => ({
    deleteObject: async (key: string) => {
      deleted.push(key);
    },
  }),
}));
vi.mock("../lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => ({ workspaceId: "w1", role: "OWNER" }),
  canManageWorkspace: () => true,
}));
vi.mock("../lib/auth", () => ({ getCurrentWorkspaceId: async () => "w1" }));

import { NextRequest } from "next/server";
import { DELETE, PATCH } from "../app/api/automations/route";
import { db, resetDb } from "./helpers/db-instance";

const PDF = "ws/w1/2026/11/abc123.pdf";
const PNG = "ws/w1/2026/11/img123.png";

const patch = (id: string, body: unknown) =>
  PATCH(new NextRequest(`http://localhost/api/automations?id=${id}`, { method: "PATCH", body: JSON.stringify(body) }));
const remove = (id: string) => DELETE(new NextRequest(`http://localhost/api/automations?id=${id}`, { method: "DELETE" }));
const row = (id: string) => db.rows("automation").find((r) => r.id === id)!;

beforeEach(() => {
  resetDb();
  deleted.length = 0;
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  db.seed("automation", { id: "a1", workspaceId: "w1", name: "C", dmMessage: "hi", dmFileKey: PDF, dmFileName: "narx.pdf", dmFileMime: "application/pdf", dmFileSize: 10 });
});

describe("campaign file on PATCH", () => {
  it("refuses a key from another workspace or a content variant", async () => {
    expect((await patch("a1", { dmFileKey: "ws/w2/2026/11/abc123.pdf" })).status).toBe(400);
    expect((await patch("a1", { dmFileKey: "ws/w1/2026/11/abc123.thumb.jpg" })).status).toBe(400);
    expect(row("a1").dmFileKey).toBe(PDF);
  });

  it("takes the type from the key, not from the browser", async () => {
    const res = await patch("a1", { dmFileKey: PNG, dmFileName: "menu.png", dmFileMime: "application/pdf", dmFileSize: 20 });
    expect(res.status).toBe(200);
    expect(row("a1")).toMatchObject({ dmFileKey: PNG, dmFileName: "menu.png", dmFileMime: "image/png", dmFileSize: 20 });
    expect(deleted).toEqual([PDF]);
  });

  it("ignores file metadata sent without the file", async () => {
    await patch("a1", { dmFileMime: "video/mp4", dmFileName: "x" });
    expect(row("a1")).toMatchObject({ dmFileKey: PDF, dmFileName: "narx.pdf", dmFileMime: "application/pdf" });
  });

  it("clearing the file clears its metadata and removes the object", async () => {
    await patch("a1", { dmFileKey: null });
    expect(row("a1")).toMatchObject({ dmFileKey: null, dmFileName: null, dmFileMime: null, dmFileSize: null });
    expect(deleted).toEqual([PDF]);
  });

  it("keeps the file a duplicated campaign still sends", async () => {
    db.seed("automation", { id: "a2", workspaceId: "w1", name: "C copy", dmMessage: "hi", dmFileKey: PDF });
    await patch("a1", { dmFileKey: PNG, dmFileName: "menu.png" });
    expect(deleted).toEqual([]);
    expect(row("a2").dmFileKey).toBe(PDF);
  });
});

describe("campaign DELETE", () => {
  it("removes the campaign's file", async () => {
    expect((await remove("a1")).status).toBe(200);
    expect(deleted).toEqual([PDF]);
  });

  it("keeps it when a copy still uses it", async () => {
    db.seed("automation", { id: "a2", workspaceId: "w1", name: "C copy", dmMessage: "hi", dmFileKey: PDF });
    await remove("a1");
    expect(deleted).toEqual([]);
  });
});
