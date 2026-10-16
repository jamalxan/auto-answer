/**
 * TZ 53 — workspace permission matrix. Pure functions only.
 */

import { describe, expect, it } from "vitest";
import {
  can,
  canChangeRole,
  canExportLeads,
  isReadOnlyRole,
  normalizeRole,
  PERMISSION_LABELS,
  PERMISSION_MATRIX,
  PERMISSION_ROLES,
  PERMISSIONS,
  permissionsOf,
  ROLE_LABELS,
} from "../lib/workspace-permissions";
import { DEFAULT_BROADCAST, DEFAULT_STAGES, DEFAULT_TAGS, tagSlug } from "../lib/crm/defaults";

describe("PERMISSION_MATRIX", () => {
  it("OWNER can do everything, ADMIN everything but billing", () => {
    for (const permission of PERMISSIONS) {
      expect(can("OWNER", permission), permission).toBe(true);
      expect(can("ADMIN", permission), permission).toBe(permission !== "manage_billing");
    }
  });

  it("MANAGER runs campaigns, AI, leads and exports but not Instagram or billing", () => {
    expect(permissionsOf("MANAGER")).toEqual(["manage_campaigns", "view_contacts", "assign_leads", "manage_ai", "export_data", "view_analytics"]);
  });

  it("OPERATOR works contacts and takes leads; VIEWER only reads", () => {
    expect(permissionsOf("OPERATOR")).toEqual(["view_contacts", "assign_leads", "view_analytics"]);
    expect(permissionsOf("VIEWER")).toEqual(["view_contacts", "view_analytics"]);
    expect(can("VIEWER", "export_data")).toBe(false);
    expect(can("VIEWER", "assign_leads")).toBe(false);
  });

  it("MEMBER is the legacy alias of OPERATOR", () => {
    expect(normalizeRole("MEMBER")).toBe("OPERATOR");
    expect(permissionsOf("MEMBER")).toEqual(permissionsOf("OPERATOR"));
    expect(can("MEMBER", "manage_campaigns")).toBe(false);
  });

  it("unknown, empty and null roles are treated as VIEWER", () => {
    expect(normalizeRole("SUPERUSER")).toBe("VIEWER");
    expect(normalizeRole("")).toBe("VIEWER");
    expect(normalizeRole(null)).toBe("VIEWER");
    expect(normalizeRole(undefined)).toBe("VIEWER");
    expect(can("SUPERUSER", "manage_billing")).toBe(false);
    expect(can(undefined, "view_contacts")).toBe(true);
  });

  it("role input is case-insensitive", () => {
    expect(normalizeRole("owner")).toBe("OWNER");
    expect(can("admin", "manage_ai")).toBe(true);
  });

  it("is complete: every role lists every permission, with Uzbek labels", () => {
    for (const role of PERMISSION_ROLES) {
      expect(Object.keys(PERMISSION_MATRIX[role]).sort()).toEqual([...PERMISSIONS].sort());
      expect(ROLE_LABELS[role]).toBeTruthy();
    }
    for (const permission of PERMISSIONS) expect(PERMISSION_LABELS[permission]).toBeTruthy();
    expect(ROLE_LABELS.VIEWER).toBe("Kuzatuvchi");
  });

  it("isReadOnlyRole: VIEWER and strangers get 403 on writes", () => {
    expect(isReadOnlyRole("VIEWER")).toBe(true);
    expect(isReadOnlyRole("whatever")).toBe(true);
    expect(isReadOnlyRole("OPERATOR")).toBe(false);
    expect(isReadOnlyRole("MEMBER")).toBe(false);
    expect(isReadOnlyRole("OWNER")).toBe(false);
  });

  it("canChangeRole: OWNER anyone, ADMIN below admin, others nobody", () => {
    expect(canChangeRole("OWNER", "ADMIN")).toBe(true);
    expect(canChangeRole("OWNER", "OWNER")).toBe(true);
    expect(canChangeRole("ADMIN", "MANAGER")).toBe(true);
    expect(canChangeRole("ADMIN", "MEMBER")).toBe(true);
    expect(canChangeRole("ADMIN", "ADMIN")).toBe(false);
    expect(canChangeRole("ADMIN", "OWNER")).toBe(false);
    expect(canChangeRole("MANAGER", "VIEWER")).toBe(false);
    expect(canChangeRole("VIEWER", "VIEWER")).toBe(false);
  });
});

describe("canExportLeads (production leads CSV)", () => {
  it("OWNER / ADMIN / MANAGER and legacy MEMBER may export; OPERATOR, VIEWER and unknown roles may not", () => {
    expect(["OWNER", "ADMIN", "MANAGER", "MEMBER"].map(canExportLeads)).toEqual([true, true, true, true]);
    expect(["OPERATOR", "VIEWER", "", null, "STRANGER"].map(canExportLeads)).toEqual([false, false, false, false, false]);
  });
});

describe("CRM defaults", () => {
  it("default stages follow the owner's pipeline with one entry stage and WON / LOST ends", () => {
    expect(DEFAULT_STAGES.map((s) => s.name)).toEqual(["Yangi lead", "Bog'lanildi", "Saralangan", "Hot", "Muzokara", "Yutildi", "Yo'qotildi"]);
    expect(DEFAULT_STAGES.filter((s) => s.isEntry).map((s) => s.key)).toEqual(["NEW"]);
    expect(DEFAULT_STAGES.map((s) => s.sort)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(DEFAULT_STAGES.find((s) => s.key === "WON")?.kind).toBe("WON");
    expect(DEFAULT_STAGES.find((s) => s.key === "LOST")?.kind).toBe("LOST");
    expect(DEFAULT_STAGES.filter((s) => s.kind === "OPEN")).toHaveLength(5);
    for (const stage of DEFAULT_STAGES) expect(stage.color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("default tags have unique slugs derived from their names", () => {
    expect(DEFAULT_TAGS.map((t) => t.name)).toEqual(["HOT", "VIP", "YANGI", "QAYTA", "TO'LOV KUTILMOQDA"]);
    for (const tag of DEFAULT_TAGS) expect(tagSlug(tag.name)).toBe(tag.slug);
    expect(new Set(DEFAULT_TAGS.map((t) => t.slug)).size).toBe(DEFAULT_TAGS.length);
  });

  it("tagSlug folds script, apostrophes and spaces", () => {
    expect(tagSlug("TO'LOV KUTILMOQDA")).toBe("tolov-kutilmoqda");
    expect(tagSlug("  Yangi   mijoz ")).toBe("yangi-mijoz");
    expect(tagSlug("Тўлов")).toBe("tolov");
    expect(tagSlug("IELTS 7.5!")).toBe("ielts-7-5");
  });

  it("broadcast defaults match the design", () => {
    expect(DEFAULT_BROADCAST).toEqual({ throttlePerHour: 100, frequencyCapHours: 24, replyWindowHours: 48, conversionWindowDays: 7 });
  });
});
