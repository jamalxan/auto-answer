/** GET /api/analytics/networks/[network]: the detail view's two-step load (live=0 first, then the platform metrics). */
import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireWorkspace: vi.fn(async () => ({ ok: true as const, ctx: { workspaceId: "ws1" } })),
  getNetworkDetail: vi.fn(async () => ({ network: "youtube", posts: [] })),
}));
vi.mock("@/lib/api-auth", () => ({
  requireWorkspace: mocks.requireWorkspace,
  jsonOk: (data: unknown) => Response.json({ success: true, data }),
  jsonError: (error: string, status: number) => Response.json({ success: false, error }, { status }),
}));
vi.mock("@/lib/analytics/network-stats", () => ({
  DETAIL_NETWORKS: ["facebook", "threads", "youtube", "telegram"],
  getNetworkDetail: mocks.getNetworkDetail,
}));

import { GET } from "@/app/api/analytics/networks/[network]/route";

const call = (qs: string, network = "youtube") => GET(new NextRequest(`http://x/api/analytics/networks/${network}${qs}`), { params: Promise.resolve({ network }) });

describe("GET /api/analytics/networks/[network]", () => {
  it("live=0 answers from the database only; the default also fetches the platform metrics", async () => {
    expect((await call("?days=7&live=0")).status).toBe(200);
    expect(mocks.getNetworkDetail).toHaveBeenLastCalledWith("ws1", "youtube", { days: 7, accountId: null, live: false });
    await call("?days=30&account=yt1");
    expect(mocks.getNetworkDetail).toHaveBeenLastCalledWith("ws1", "youtube", { days: 30, accountId: "yt1", live: true });
  });

  it("rejects an unknown network and a bad range", async () => {
    expect((await call("?days=30", "tiktok")).status).toBe(404);
    expect((await call("?days=12")).status).toBe(400);
  });
});
