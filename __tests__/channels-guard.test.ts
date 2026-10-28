import { beforeEach, describe, expect, it, vi } from "vitest";

const ctx = vi.hoisted(() => ({ value: null as null | { workspaceId: string; role: string } }));
vi.mock("@/lib/workspace-access", async () => {
  const roles = await vi.importActual<typeof import("@/lib/workspace-roles")>("@/lib/workspace-roles");
  return { canManageWorkspace: roles.canManageWorkspace, getCurrentWorkspaceContext: async () => ctx.value };
});

import { requireWorkspace } from "@/lib/channels/guard";

describe("requireWorkspace (Channels and Ads on the main dashboard)", () => {
  beforeEach(() => {
    ctx.value = null;
  });

  it("answers 401 without an app session", async () => {
    const auth = await requireWorkspace();
    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.response.status).toBe(401);
  });

  it("lets every role read", async () => {
    ctx.value = { workspaceId: "w1", role: "VIEWER" };
    const auth = await requireWorkspace();
    expect(auth.ok).toBe(true);
  });

  it("lets only an owner or admin change things", async () => {
    ctx.value = { workspaceId: "w1", role: "VIEWER" };
    const viewer = await requireWorkspace(true);
    expect(viewer.ok).toBe(false);
    if (!viewer.ok) expect(viewer.response.status).toBe(403);

    ctx.value = { workspaceId: "w1", role: "OWNER" };
    expect((await requireWorkspace(true)).ok).toBe(true);
  });
});
