/**
 * The fair draw: commit–reveal, pure (no database, no clock, no network).
 *
 *   commit  seedHex = 32 random bytes (hex); commitment = sha256(utf8(seedHex)),
 *           published BEFORE the draw. Anyone can later check
 *           `printf %s <seedHex> | sha256sum` against it.
 *   draw    entrants sorted by igUserId (plain code-unit order), entrantsHash =
 *           sha256 of the ids joined by "\n". Randomness is the stream
 *           HMAC-SHA256(key = seed bytes, msg = "<entrantsHash>:<counter>");
 *           numbers below n come from 32-bit words by rejection sampling (no
 *           modulo bias); Fisher–Yates shuffles the sorted list; the first
 *           `winners` are winners, the next `backups` are backups.
 *   reveal  the seed and the one-line `verification` string; verifyDraw()
 *           recomputes everything from them.
 *
 * Algorithm id: hmac-sha256-fisher-yates/v1. Binding the entrants hash into
 * the HMAC message means changing one entrant changes the whole result.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";

export const DRAW_ALGORITHM = "hmac-sha256-fisher-yates/v1";

export interface DrawEntrant {
  /** The row id the result is reported in (GiveawayEntry.id). */
  id: string;
  /** The public, stable identity the list is sorted and hashed by. */
  igUserId: string;
}

export interface DrawInput {
  seedHex: string;
  entrants: DrawEntrant[];
  winners: number;
  backups: number;
}

export interface DrawResult {
  algorithm: string;
  entrantsHash: string;
  winnerIds: string[];
  backupIds: string[];
  /** One line anyone can recompute: seed, commitment, entrants and the picked igUserIds. */
  verification: string;
}

const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** A fresh seed and its public commitment. */
export function createCommitment(): { seedHex: string; commitment: string } {
  const seedHex = randomBytes(32).toString("hex");
  return { seedHex, commitment: commitmentOf(seedHex) };
}

export function commitmentOf(seedHex: string): string {
  return sha256Hex(seedHex);
}

function sortEntrants(entrants: DrawEntrant[]): DrawEntrant[] {
  return [...entrants].sort((a, b) => (a.igUserId < b.igUserId ? -1 : a.igUserId > b.igUserId ? 1 : 0));
}

export function hashEntrants(entrants: Array<Pick<DrawEntrant, "igUserId">>): string {
  const ids = entrants.map((e) => e.igUserId).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(ids.join("\n"));
}

/** The HMAC byte stream, consumed as 32-bit big-endian words. */
class WordStream {
  private counter = 0;
  private block: Buffer = Buffer.alloc(0);
  private offset = 0;
  private readonly key: Buffer;

  constructor(
    seedHex: string,
    private readonly context: string
  ) {
    this.key = Buffer.from(seedHex, "hex");
  }

  next(): number {
    if (this.offset + 4 > this.block.length) {
      this.block = createHmac("sha256", this.key).update(`${this.context}:${this.counter++}`).digest();
      this.offset = 0;
    }
    const word = this.block.readUInt32BE(this.offset);
    this.offset += 4;
    return word;
  }

  /** Uniform integer in [0, n) by rejection sampling. */
  below(n: number): number {
    if (n <= 1) return 0;
    const range = 0x1_0000_0000;
    const limit = range - (range % n);
    for (;;) {
      const word = this.next();
      if (word < limit) return word % n;
    }
  }
}

export function drawWinners(input: DrawInput): DrawResult {
  if (!/^[0-9a-f]{64}$/.test(input.seedHex)) throw new Error("Seed noto'g'ri formatda");
  const sorted = sortEntrants(input.entrants);
  const entrantsHash = hashEntrants(sorted);
  const stream = new WordStream(input.seedHex, entrantsHash);

  const order = [...sorted];
  for (let i = order.length - 1; i > 0; i--) {
    const j = stream.below(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }

  const winners = Math.max(0, Math.min(Math.floor(input.winners), order.length));
  const backups = Math.max(0, Math.min(Math.floor(input.backups), order.length - winners));
  const winnerPicks = order.slice(0, winners);
  const backupPicks = order.slice(winners, winners + backups);

  const verification =
    `${DRAW_ALGORITHM} seed=${input.seedHex} commitment=${commitmentOf(input.seedHex)} ` +
    `entrants=${sorted.length}:${entrantsHash} winners=${winners} backups=${backups} ` +
    `result=${winnerPicks.map((e) => e.igUserId).join(",")}|${backupPicks.map((e) => e.igUserId).join(",")}`;

  return {
    algorithm: DRAW_ALGORITHM,
    entrantsHash,
    winnerIds: winnerPicks.map((e) => e.id),
    backupIds: backupPicks.map((e) => e.id),
    verification,
  };
}

export interface DrawReveal {
  seedHex: string;
  entrants: DrawEntrant[];
  winners: number;
  backups: number;
  /** Everything below is optional: each given value must match the recomputation. */
  algorithm?: string;
  commitment?: string;
  entrantsHash?: string;
  winnerIds?: string[];
  backupIds?: string[];
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Recompute a draw from its reveal; `ok` only when every given claim matches. */
export function verifyDraw(reveal: DrawReveal): { ok: boolean; winnerIds: string[]; backupIds: string[]; problems: string[] } {
  const problems: string[] = [];
  if (reveal.algorithm !== undefined && reveal.algorithm !== DRAW_ALGORITHM) {
    return { ok: false, winnerIds: [], backupIds: [], problems: [`Noma'lum algoritm: ${reveal.algorithm}`] };
  }
  if (!/^[0-9a-f]{64}$/.test(reveal.seedHex ?? "")) {
    return { ok: false, winnerIds: [], backupIds: [], problems: ["Seed noto'g'ri formatda"] };
  }
  if (reveal.commitment !== undefined && reveal.commitment !== commitmentOf(reveal.seedHex)) {
    problems.push("Commitment sha256(seed) ga mos kelmaydi");
  }
  const result = drawWinners(reveal);
  if (reveal.entrantsHash !== undefined && reveal.entrantsHash !== result.entrantsHash) {
    problems.push("Ishtirokchilar ro'yxati hash'i mos kelmaydi");
  }
  if (reveal.winnerIds !== undefined && !sameList(reveal.winnerIds, result.winnerIds)) {
    problems.push("G'oliblar qayta hisoblashga mos kelmaydi");
  }
  if (reveal.backupIds !== undefined && !sameList(reveal.backupIds, result.backupIds)) {
    problems.push("Zaxira g'oliblar qayta hisoblashga mos kelmaydi");
  }
  return { ok: problems.length === 0, winnerIds: result.winnerIds, backupIds: result.backupIds, problems };
}
