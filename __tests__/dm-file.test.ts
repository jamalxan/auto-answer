/**
 * The DM file helpers shared by campaigns and auto-reply rules: which keys a
 * record may point at, the type read from the key, the link line that never
 * gets cut, the reference-counted delete, and the upload route's size guard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { deleted, context } = vi.hoisted(() => ({
  deleted: [] as string[],
  context: { value: { workspaceId: "w1", role: "OWNER" } as { workspaceId: string; role: string } | null },
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/content/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/content/storage")>()),
  getStorage: () => ({
    presignGet: async (key: string, ttl: number) => `https://cdn.test/${key}?ttl=${ttl}`,
    deleteObject: async (key: string) => {
      deleted.push(key);
    },
    putObject: async () => undefined,
  }),
}));
vi.mock("../lib/workspace-access", () => ({
  getCurrentWorkspaceContext: async () => context.value,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { appendLine, cleanDmFileName, deleteDmFile, dmFileLinkLine, dmFileMimeForKey, DM_FILE_MAX_BODY_BYTES } from "../lib/campaigns/dm-file";
import { DELETE, POST } from "../app/api/automations/file/route";
import { db, resetDb } from "./helpers/db-instance";
import { NextRequest } from "next/server";

const KEY = "ws/w1/2026/11/abc123.pdf";

beforeEach(() => {
  resetDb();
  deleted.length = 0;
  context.value = { workspaceId: "w1", role: "OWNER" };
});

describe("dmFileMimeForKey", () => {
  it("reads the type from a DM file key in the workspace", () => {
    expect(dmFileMimeForKey("w1", KEY)).toBe("application/pdf");
    expect(dmFileMimeForKey("w1", "ws/w1/2026/11/abc.jpg")).toBe("image/jpeg");
    expect(dmFileMimeForKey("w1", "ws/w1/2026/11/abc.m4a")).toBe("audio/mp4");
  });

  it("refuses other workspaces, content variants, unknown types and junk", () => {
    expect(dmFileMimeForKey("w2", KEY)).toBeNull();
    expect(dmFileMimeForKey("w1", "ws/w1/2026/11/abc.thumb.jpg")).toBeNull();
    expect(dmFileMimeForKey("w1", "ws/w1/2026/11/abc.prepared.mp4")).toBeNull();
    expect(dmFileMimeForKey("w1", "ws/w1/2026/11/abc.mov")).toBeNull();
    expect(dmFileMimeForKey("w1", "ws/w1/../w2/2026/11/abc.pdf")).toBeNull();
    expect(dmFileMimeForKey("w1", "")).toBeNull();
  });
});

describe("appendLine", () => {
  it("adds the line as its own paragraph", () => {
    expect(appendLine("Salom", "📎 a: url", 100)).toBe("Salom\n\n📎 a: url");
    expect(appendLine("", "📎 a: url", 100)).toBe("📎 a: url");
  });

  it("shortens the text, never the line, to fit the limit", () => {
    const line = `📎 a: https://x/${"q".repeat(50)}`;
    const out = appendLine("y".repeat(500), line, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith(`…\n\n${line}`)).toBe(true);
  });
});

describe("file name and link", () => {
  it("keeps names on one line with a fallback", () => {
    expect(cleanDmFileName("a\nb\tc.pdf")).toBe("a b c.pdf");
    expect(cleanDmFileName("   ")).toBe("Fayl");
    expect(cleanDmFileName(null)).toBe("Fayl");
  });

  it("links for seven days", async () => {
    expect(await dmFileLinkLine(KEY, "narx.pdf")).toBe(`📎 narx.pdf: https://cdn.test/${KEY}?ttl=604800`);
  });
});

describe("deleteDmFile", () => {
  it("deletes a file nothing points at", async () => {
    await deleteDmFile(KEY);
    expect(deleted).toEqual([KEY]);
  });

  it("keeps a file a duplicated campaign still sends", async () => {
    db.seed("automation", { id: "copy", workspaceId: "w1", name: "C copy", dmMessage: "hi", dmFileKey: KEY });
    await deleteDmFile(KEY);
    expect(deleted).toEqual([]);
  });

  it("keeps a file an auto-reply rule uses", async () => {
    db.seed("channelAutoReply", { id: "r1", workspaceId: "w1", channel: "facebook", name: "R", fileKey: KEY });
    await deleteDmFile(KEY);
    expect(deleted).toEqual([]);
  });

  it("never deletes a content upload", async () => {
    db.seed("mediaAsset", { id: "m1", workspaceId: "w1", originalKey: KEY, kind: "IMAGE" });
    await deleteDmFile(KEY);
    expect(deleted).toEqual([]);
  });
});

describe("/api/automations/file", () => {
  const upload = (headers: Record<string, string>, body?: BodyInit) =>
    POST(new NextRequest("http://localhost/api/automations/file", { method: "POST", headers, body }));

  it("refuses a body over the limit before reading it", async () => {
    const res = await upload({ "content-length": String(DM_FILE_MAX_BODY_BYTES + 1) });
    expect(res.status).toBe(413);
  });

  it("refuses a body of unknown size", async () => {
    const res = await upload({});
    expect(res.status).toBe(411);
  });

  it("stores an allowed file and answers with its key", async () => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array([37, 80, 68, 70])], "narx.pdf", { type: "application/pdf" }));
    const req = new Request("http://localhost/x", { method: "POST", body: form });
    const body = await req.arrayBuffer();
    const res = await upload({ "content-type": req.headers.get("content-type")!, "content-length": String(body.byteLength) }, body);
    expect(res.status).toBe(201);
    const data = (await res.json()).data;
    expect(dmFileMimeForKey("w1", data.key)).toBe("application/pdf");
    expect(data.name).toBe("narx.pdf");
  });

  it("is owners and admins only", async () => {
    context.value = { workspaceId: "w1", role: "MEMBER" };
    expect((await upload({ "content-length": "10" })).status).toBe(403);
    context.value = null;
    expect((await upload({ "content-length": "10" })).status).toBe(401);
  });

  it("DELETE drops an unused upload, keeps a used one, refuses foreign keys", async () => {
    const del = (key: string) => DELETE(new NextRequest(`http://localhost/api/automations/file?key=${encodeURIComponent(key)}`, { method: "DELETE" }));
    expect((await del("ws/w2/2026/11/abc123.pdf")).status).toBe(400);
    expect(deleted).toEqual([]);
    db.seed("automation", { id: "a1", workspaceId: "w1", name: "C", dmMessage: "hi", dmFileKey: KEY });
    expect((await del(KEY)).status).toBe(200);
    expect(deleted).toEqual([]);
    expect((await del("ws/w1/2026/11/other.png")).status).toBe(200);
    expect(deleted).toEqual(["ws/w1/2026/11/other.png"]);
  });
});
