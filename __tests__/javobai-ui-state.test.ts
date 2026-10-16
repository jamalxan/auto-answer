import { describe, expect, it } from "vitest";
import { intentExamplePreview } from "../components/developer/comments/shared";
import { offModeDescription, profileStateText, type ProfileStatus } from "../components/developer/javobai/shared";
import { BUILT_IN_INTENTS } from "../lib/triggers/keywords";

const base: ProfileStatus = { exists: true, live: false, scope: "account", id: "p", companyName: "X" };

describe("JavobAI OFF mode shows the real production state (B-41)", () => {
  it("assistant on -> says production answers", () => {
    expect(offModeDescription({ ...base, live: true, approved: true, enabled: true })).toContain("yoqilgan");
  });
  it("assistant disabled -> does not claim production answers", () => {
    const text = offModeDescription({ ...base, approved: true, enabled: false });
    expect(text).toContain("o'chirilgan");
    expect(text).not.toContain("assistent javob beradi");
  });
  it("not approved / no profile -> says nobody answers", () => {
    expect(offModeDescription({ ...base, approved: false, enabled: false })).toContain("tasdiqlanmagan");
    expect(offModeDescription({ ...base, exists: false })).toContain("bermaydi");
  });
  it("uses the assistant page words for approval", () => {
    expect(profileStateText({ ...base, approved: true, enabled: false })).toBe("tasdiqlangan · o'chirilgan");
    expect(profileStateText({ ...base, live: true, approved: true, enabled: true })).toBe("tasdiqlangan · yoqilgan");
    expect(profileStateText({ ...base, approved: false })).toBe("tasdiqlanmagan");
  });
});

describe("intent vocabulary preview (B-20)", () => {
  it("shows Latin and Cyrillic variants", () => {
    const price = BUILT_IN_INTENTS.find((i) => i.key === "PRICE")!;
    const preview = intentExamplePreview(price.examples);
    expect(preview).toMatch(/[a-z]/);
    expect(preview).toMatch(/[Ѐ-ӿ]/);
  });
});
