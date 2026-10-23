/**
 * ETAP 13 Faza 2 — the pure CSV half (FR-I1, FR-I2): the parser's edge cases
 * (BOM, quotes, delimiters and newlines inside quotes, ";" files), header
 * mapping, and the per-row normalization / validation.
 */
import { describe, expect, it } from "vitest";
import { csvTemplate, CsvError, normalizeCsv, parseCsv, parseDate, parseTime, parseUserTags, resolveType, type CsvContext } from "@/lib/content/csv";

const NOW = new Date("2026-10-24T10:00:00Z");
const ctx = (over: Partial<CsvContext> = {}): CsvContext => ({
  accounts: [
    { id: "acc1", username: "jamalxann", canPublish: true },
    { id: "acc2", username: "Mebel_Uz", canPublish: false },
  ],
  campaigns: [
    { kind: "trigger", id: "tc1", name: "Narx", instagramAccountId: "acc1", keywords: ["narx", "price"], live: false },
    { kind: "automation", id: "au1", name: "Live", instagramAccountId: "acc1", keywords: ["band"], live: true },
  ],
  timezone: "Asia/Tashkent",
  now: NOW,
  carouselMax: 10,
  maxCollaborators: 3,
  ...over,
});

const HEADER = "text,date,time,account,type,media_url_1,media_url_2,alt_text_1,draft,campaign_keyword";
const file = (...rows: string[]) => [HEADER, ...rows].join("\n");

describe("parseCsv", () => {
  it("strips the BOM and handles CRLF, LF and lone CR", () => {
    const { records } = parseCsv("﻿a,b\r\n1,2\n3,4\r5,6");
    expect(records).toEqual([["a", "b"], ["1", "2"], ["3", "4"], ["5", "6"]]);
  });

  it("keeps commas, newlines and escaped quotes inside quoted fields", () => {
    const { records } = parseCsv('text,x\n"Salom, dunyo\nikkinchi qator ""iqtibos""",2\n');
    expect(records).toEqual([["text", "x"], ['Salom, dunyo\nikkinchi qator "iqtibos"', "2"]]);
  });

  it("keeps empty fields and a trailing empty field", () => {
    expect(parseCsv("a,,c,\n").records).toEqual([["a", "", "c", ""]]);
  });

  it("detects ';' files (Excel in a ru / uz locale) and keeps ';' inside quotes", () => {
    const { records, delimiter } = parseCsv('text;user_tags\n"a,b";"@x:0.1:0.2;@y"\n');
    expect(delimiter).toBe(";");
    expect(records[1]).toEqual(["a,b", "@x:0.1:0.2;@y"]);
  });

  it("refuses an unterminated quote with the row it started on", () => {
    expect(() => parseCsv('a,b\n1,"open\n2,3')).toThrow(CsvError);
    expect(() => parseCsv('a,b\n1,"open\n2,3')).toThrow(/2-qator/);
  });

  it("reads Cyrillic and emoji unchanged", () => {
    expect(parseCsv("t\nПривет 👋\n").records[1]).toEqual(["Привет 👋"]);
  });
});

describe("small parsers", () => {
  it("dates: ISO and DD.MM.YYYY, invalid calendar days refused", () => {
    expect(parseDate("2026-11-01")).toBe("2026-11-01");
    expect(parseDate("1.11.2026")).toBe("2026-11-01");
    expect(parseDate("31/12/2026")).toBe("2026-12-31");
    expect(parseDate("2026-02-30")).toBeNull();
    expect(parseDate("tomorrow")).toBeNull();
  });

  it("times: H:mm, HH:mm, HH:mm:ss", () => {
    expect(parseTime("9:05")).toBe("09:05");
    expect(parseTime("19:00:00")).toBe("19:00");
    expect(parseTime("24:00")).toBeNull();
  });

  it("user tags with and without coordinates; bad ones reported", () => {
    const errors: string[] = [];
    expect(parseUserTags("@ali:0.5:0.25; vali ;@x:2:0", errors)).toEqual([{ username: "ali", x: 0.5, y: 0.25 }, { username: "vali" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/0 dan 1 gacha/);
  });

  it("POST becomes a carousel, feed image or feed video by its media", () => {
    expect(resolveType("POST", ["IMAGE", "VIDEO"])).toBe("CAROUSEL");
    expect(resolveType("POST", ["VIDEO"])).toBe("FEED_VIDEO");
    expect(resolveType("POST", ["IMAGE"])).toBe("FEED_IMAGE");
    expect(resolveType("REEL", ["VIDEO"])).toBe("REEL");
    expect(resolveType("STORY", ["IMAGE"])).toBe("STORY");
  });
});

describe("normalizeCsv", () => {
  it("a good row: account by username (case-insensitive, @ optional), workspace time zone, campaign by keyword", () => {
    const p = normalizeCsv(file("Salom #mebel,2026-11-01,19:00,@JAMALXANN,POST,https://cdn.x.uz/a.jpg,,Divan,0,Narx"), ctx());
    expect(p.fileErrors).toEqual([]);
    expect(p.rows).toHaveLength(1);
    const r = p.rows[0];
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ row: 2, accountId: "acc1", type: "FEED_IMAGE", caption: "Salom #mebel", draft: false, autoPublish: true, campaign: { id: "tc1", kind: "trigger" } });
    expect(r.scheduledAt).toBe("2026-11-01T14:00:00.000Z"); // 19:00 Tashkent = 14:00 UTC
    expect(r.media).toEqual([{ url: "https://cdn.x.uz/a.jpg", guessedKind: "IMAGE", altText: "Divan" }]);
    expect(p.valid).toBe(1);
  });

  it("two media make a carousel; a single video POST becomes a feed video with a warning", () => {
    const p = normalizeCsv(file("c,2026-11-01,19:00,jamalxann,POST,https://x.uz/1.jpg,https://x.uz/2.mp4,,0,", "v,2026-11-01,20:00,jamalxann,,https://x.uz/v.mp4,,,0,"), ctx());
    expect(p.rows[0].type).toBe("CAROUSEL");
    expect(p.rows[1].type).toBe("FEED_VIDEO");
    expect(p.rows[1].warnings.join(" ")).toMatch(/Reels/);
    expect(p.rows.every((r) => r.errors.length === 0)).toBe(true);
  });

  it("reports every problem of a bad row: unknown account, bad type, http url, past time", () => {
    const p = normalizeCsv(file("x,2026-10-24,10:02,nobody,PHOTO,http://x.uz/a.jpg,,,0,"), ctx());
    const errors = p.rows[0].errors.join(" | ");
    expect(errors).toMatch(/@nobody bu workspace'da ulanmagan/);
    expect(errors).toMatch(/type: "PHOTO"/);
    expect(errors).toMatch(/media_url_1: faqat https/);
    expect(errors).toMatch(/kamida 5 daqiqa/);
    expect(p.valid).toBe(0);
  });

  it("refuses internal hosts statically (SSRF: localhost, private IP literals)", () => {
    const p = normalizeCsv(file("x,2026-11-01,19:00,jamalxann,POST,https://127.0.0.1/a.jpg,https://localhost/b.jpg,,0,"), ctx());
    expect(p.rows[0].errors.filter((e) => /ichki/.test(e))).toHaveLength(2);
  });

  it("a scheduled row needs date and time; a draft does not", () => {
    const p = normalizeCsv(file("x,,,jamalxann,POST,https://x.uz/a.jpg,,,0,", "y,,,jamalxann,POST,https://x.uz/a.jpg,,,1,"), ctx());
    expect(p.rows[0].errors.join()).toMatch(/date va time kerak/);
    expect(p.rows[1].errors).toEqual([]);
    expect(p.rows[1].draft).toBe(true);
  });

  it("field matrix: caption limit, story drops its caption, alt text on a reel is an error", () => {
    const long = "a".repeat(2201);
    const p = normalizeCsv(
      file(`${long},2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,,0,`, "story text,2026-11-01,19:10,jamalxann,STORY,https://x.uz/s.jpg,,,0,", "r,2026-11-01,19:20,jamalxann,REEL,https://x.uz/r.mp4,,alt,0,"),
      ctx()
    );
    expect(p.rows[0].errors.join()).toMatch(/2201 belgi/);
    expect(p.rows[1].caption).toBeNull();
    expect(p.rows[1].errors).toEqual([]);
    expect(p.rows[1].warnings.join()).toMatch(/caption bo'lmaydi/);
    expect(p.rows[2].errors.join()).toMatch(/media_url_1: Alt matn faqat rasmga/);
  });

  it("an image link on a REEL is refused; an extension-less link is judged by what the type wants", () => {
    const p = normalizeCsv(file("r,2026-11-01,19:00,jamalxann,REEL,https://x.uz/a.jpg,,,0,", "r2,2026-11-01,19:10,jamalxann,REEL,https://x.uz/file?id=9,,,0,"), ctx());
    expect(p.rows[0].errors.join()).toMatch(/rasm bo'lmaydi/);
    expect(p.rows[1].errors).toEqual([]);
    expect(p.rows[1].warnings.join()).toMatch(/turi yuklab olinganda aniqlanadi/);
  });

  it("an account without the publish scope is imported in manual mode with a warning", () => {
    const p = normalizeCsv(file("x,2026-11-01,19:00,mebel_uz,POST,https://x.uz/a.jpg,,,0,"), ctx());
    expect(p.rows[0]).toMatchObject({ accountId: "acc2", autoPublish: false });
    expect(p.rows[0].warnings.join()).toMatch(/qo'lda e'lon/);
  });

  it("campaign keyword: missing → warning, live campaign → warning, one campaign links one row only", () => {
    const p = normalizeCsv(
      file("a,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,,0,yoq", "b,2026-11-01,19:10,jamalxann,POST,https://x.uz/a.jpg,,,0,band", "c,2026-11-01,19:20,jamalxann,POST,https://x.uz/a.jpg,,,0,narx", "d,2026-11-01,19:30,jamalxann,POST,https://x.uz/a.jpg,,,0,price"),
      ctx()
    );
    expect(p.rows[0].campaign).toBeNull();
    expect(p.rows[0].warnings.join()).toMatch(/topilmadi/);
    expect(p.rows[1].warnings.join()).toMatch(/boshqa chiqqan postda/);
    expect(p.rows[2].campaign?.id).toBe("tc1");
    expect(p.rows[3].campaign).toBeNull();
    expect(p.rows[3].warnings.join()).toMatch(/yuqoridagi qatorga ulangan/);
    expect(p.rows.every((r) => r.errors.length === 0)).toBe(true);
  });

  it("all the FR-I1 columns: cover, frame, share_to_feed, first comment, collaborators, user tags, autopublish", () => {
    const header = "text,date,time,account,type,media_url_1,cover_url,cover_frame_ms,share_to_feed,first_comment,collaborators,user_tags,draft,autopublish";
    const p = normalizeCsv(`${header}\nr,2026-11-01,19:00,jamalxann,REEL,https://x.uz/r.mp4,https://x.uz/c.jpg,1500,0,Birinchi,"@a, b",@ali,0,0\n`, ctx());
    const r = p.rows[0];
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ type: "REEL", coverUrl: "https://x.uz/c.jpg", thumbOffsetMs: 1500, shareToFeed: false, firstComment: "Birinchi", collaborators: ["@a", "b"], autoPublish: false });
    expect(r.media[0].userTags).toEqual([{ username: "ali" }]);
  });

  it("too many collaborators and an image tag without coordinates are field-matrix errors", () => {
    const header = "text,date,time,account,type,media_url_1,collaborators,user_tags";
    const p = normalizeCsv(`${header}\nx,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,"a,b,c,d",@ali\n`, ctx());
    expect(p.rows[0].errors.join()).toMatch(/Ko'pi bilan 3 ta hammuallif/);
    expect(p.rows[0].errors.join()).toMatch(/joy \(x, y\) kerak/);
  });

  it("file-level: more than 200 rows, no header, unknown and duplicate columns", () => {
    const many = Array.from({ length: 201 }, (_, i) => `t${i},2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,,0,`);
    expect(normalizeCsv(file(...many), ctx()).fileErrors.join()).toMatch(/ko'pi bilan 200/);
    expect(() => normalizeCsv("foo,bar\n1,2\n", ctx())).toThrow(/Sarlavha/);
    expect(() => normalizeCsv("\n\n", ctx())).toThrow(/bo'sh/);
    const p = normalizeCsv("text,extra,account,draft\nx,y,jamalxann,1\n", ctx());
    expect(p.fileWarnings.join()).toMatch(/extra/);
    expect(normalizeCsv("text,text\nx,y\n", ctx()).fileErrors.join()).toMatch(/ikki marta/);
  });

  it("skips empty rows but keeps spreadsheet row numbers", () => {
    const p = normalizeCsv(file("", "a,2026-11-01,19:00,jamalxann,POST,https://x.uz/a.jpg,,,0,", ",,,,,,,,,"), ctx());
    expect(p.rows.map((r) => r.row)).toEqual([3]);
  });

  it("the template parses back with no errors except the example dates' time rule", () => {
    const p = normalizeCsv(csvTemplate("jamalxann"), ctx());
    expect(p.fileErrors).toEqual([]);
    expect(p.rows).toHaveLength(2);
    for (const r of p.rows) expect(r.errors).toEqual([]);
    expect(p.rows[0].type).toBe("CAROUSEL");
    expect(p.rows[1].type).toBe("REEL");
  });
});
