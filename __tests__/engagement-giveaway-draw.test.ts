/**
 * The fair draw (lib/engagement/giveaway/draw.ts): pure commit–reveal.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCommitment, drawWinners, hashEntrants, verifyDraw, DRAW_ALGORITHM } from "@/lib/engagement/giveaway/draw";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const SEED = sha256("fixed-seed");

const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, igUserId: String(9000 + i) }));

describe("commitment", () => {
  it("equals sha256 of the revealed seed text and is fresh each time", () => {
    const a = createCommitment();
    const b = createCommitment();
    expect(a.seedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(a.commitment).toBe(sha256(a.seedHex));
    expect(a.seedHex).not.toBe(b.seedHex);
  });
});

describe("drawWinners", () => {
  it("is deterministic for the same seed and entrants, whatever the input order", () => {
    const entrants = people(30);
    const a = drawWinners({ seedHex: SEED, entrants, winners: 3, backups: 2 });
    const b = drawWinners({ seedHex: SEED, entrants: [...entrants].reverse(), winners: 3, backups: 2 });
    expect(b).toEqual(a);
    expect(a.algorithm).toBe(DRAW_ALGORITHM);
    expect(a.winnerIds).toHaveLength(3);
    expect(a.verification).toContain(`seed=${SEED}`);
    expect(a.verification).toContain(`commitment=${sha256(SEED)}`);
  });

  it("keeps winners and backups distinct and never exceeds the entrants", () => {
    const result = drawWinners({ seedHex: SEED, entrants: people(8), winners: 3, backups: 4 });
    const all = [...result.winnerIds, ...result.backupIds];
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(7);

    const few = drawWinners({ seedHex: SEED, entrants: people(3), winners: 10, backups: 5 });
    expect(few.winnerIds).toHaveLength(3);
    expect(few.backupIds).toHaveLength(0);

    const none = drawWinners({ seedHex: SEED, entrants: [], winners: 2, backups: 1 });
    expect(none.winnerIds).toEqual([]);
  });

  it("changing one entrant changes the entrants hash and the outcome", () => {
    const entrants = people(25);
    const changed = entrants.map((e, i) => (i === 7 ? { ...e, igUserId: "1234" } : e));
    expect(hashEntrants(changed)).not.toBe(hashEntrants(entrants));

    let differs = 0;
    for (let i = 0; i < 20; i++) {
      const seedHex = sha256(`s${i}`);
      const a = drawWinners({ seedHex, entrants, winners: 3, backups: 0 });
      const b = drawWinners({ seedHex, entrants: changed, winners: 3, backups: 0 });
      expect(a.verification).not.toBe(b.verification);
      if (a.winnerIds.join() !== b.winnerIds.join()) differs++;
    }
    expect(differs).toBeGreaterThan(10);
  });

  it("picks every entrant about equally often (no modulo bias)", () => {
    const entrants = people(5);
    const counts = new Map<string, number>();
    const draws = 10_000;
    for (let i = 0; i < draws; i++) {
      const { winnerIds } = drawWinners({ seedHex: sha256(`bias-${i}`), entrants, winners: 1, backups: 0 });
      counts.set(winnerIds[0], (counts.get(winnerIds[0]) ?? 0) + 1);
    }
    const expected = draws / entrants.length;
    const chi2 = entrants.reduce((sum, e) => sum + ((counts.get(e.id) ?? 0) - expected) ** 2 / expected, 0);
    // df = 4: 18.47 is the 0.1% critical value.
    expect(chi2).toBeLessThan(18.47);
  });

  it("every ordered pair of two winners out of three appears (shuffle covers all positions)", () => {
    const entrants = people(3);
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      seen.add(drawWinners({ seedHex: sha256(`pair-${i}`), entrants, winners: 2, backups: 0 }).winnerIds.join(">"));
    }
    expect(seen.size).toBe(6);
  });

  it("rejects a malformed seed", () => {
    expect(() => drawWinners({ seedHex: "nope", entrants: people(2), winners: 1, backups: 0 })).toThrow();
  });
});

describe("verifyDraw", () => {
  it("reproduces the winners from the reveal", () => {
    const { seedHex, commitment } = createCommitment();
    const entrants = people(40);
    const draw = drawWinners({ seedHex, entrants, winners: 4, backups: 2 });
    const check = verifyDraw({
      seedHex,
      commitment,
      entrants,
      winners: 4,
      backups: 2,
      algorithm: draw.algorithm,
      entrantsHash: draw.entrantsHash,
      winnerIds: draw.winnerIds,
      backupIds: draw.backupIds,
    });
    expect(check.ok).toBe(true);
    expect(check.winnerIds).toEqual(draw.winnerIds);
  });

  it("fails on a wrong commitment, tampered winners, a changed entrant list or an unknown algorithm", () => {
    const entrants = people(12);
    const draw = drawWinners({ seedHex: SEED, entrants, winners: 2, backups: 1 });
    const base = { seedHex: SEED, entrants, winners: 2, backups: 1, winnerIds: draw.winnerIds, backupIds: draw.backupIds };
    expect(verifyDraw({ ...base, commitment: sha256("other") }).ok).toBe(false);
    expect(verifyDraw({ ...base, winnerIds: [...draw.winnerIds].reverse() }).ok).toBe(false);
    expect(verifyDraw({ ...base, entrantsHash: hashEntrants(people(11)) }).ok).toBe(false);
    expect(verifyDraw({ ...base, algorithm: "other/v9" }).ok).toBe(false);
    expect(verifyDraw({ ...base, commitment: sha256(SEED) }).ok).toBe(true);
  });
});
