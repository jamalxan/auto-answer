/** ETAP 8 Google Sheets connector: service account parsing, RS256 JWT, request shapes, errors, rows. */

import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sampleEvent } from "../lib/integrations2/events";
import {
  GOOGLE_TOKEN_URL,
  SHEETS_SCOPE,
  buildAddSheetRequest,
  buildAppendRequest,
  buildHeaderReadRequest,
  buildHeaderWriteRequest,
  buildJwtAssertion,
  buildTokenRequest,
  classifySheetsError,
  parseServiceAccountJson,
  parseSpreadsheetId,
  parseTokenResponse,
  sheetRange,
  tokenCacheKey,
} from "../lib/integrations2/connectors/sheets-auth";
import { SHEET_HEADERS, formatTashkent, headersMatch, payloadToRow } from "../lib/integrations2/connectors/sheets-rows";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

const serviceAccount = {
  type: "service_account",
  project_id: "demo-project",
  client_email: "bot@demo-project.iam.gserviceaccount.com",
  private_key: privateKey,
};

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("parseServiceAccountJson", () => {
  it("accepts a service account file and normalises escaped newlines", () => {
    const escaped = JSON.stringify({ ...serviceAccount, private_key: privateKey.replace(/\n/g, "\\n") });
    const result = parseServiceAccountJson(escaped);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.account).toEqual({ client_email: serviceAccount.client_email, private_key: privateKey, project_id: "demo-project" });
    }
    const minimal = parseServiceAccountJson(JSON.stringify({ type: "service_account", client_email: serviceAccount.client_email, private_key: privateKey }));
    expect(minimal).toMatchObject({ ok: true, account: { project_id: null } });
  });

  it("rejects other key types, invalid JSON and missing fields", () => {
    expect(parseServiceAccountJson("{not json")).toMatchObject({ ok: false, reason: "Fayl JSON formatida emas" });
    expect(parseServiceAccountJson(JSON.stringify({ type: "authorized_user", client_id: "x" }))).toMatchObject({ ok: false, reason: expect.stringContaining("service account") });
    expect(parseServiceAccountJson(JSON.stringify({ installed: { client_id: "x" } }))).toMatchObject({ ok: false });
    expect(parseServiceAccountJson(JSON.stringify({ ...serviceAccount, private_key: "nope" }))).toMatchObject({ ok: false, reason: expect.stringContaining("private_key") });
    expect(parseServiceAccountJson(JSON.stringify({ ...serviceAccount, client_email: "not-an-email" }))).toMatchObject({ ok: false });
  });
});

describe("buildJwtAssertion", () => {
  it("produces an RS256 JWT that verifies with the public key and carries the claims", () => {
    const now = new Date("2026-10-16T09:00:00Z");
    const iat = Math.floor(now.getTime() / 1000);
    const jwt = buildJwtAssertion({ clientEmail: serviceAccount.client_email, privateKey, now });
    const [header, claims, signature] = jwt.split(".");
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(claims)).toEqual({
      iss: serviceAccount.client_email,
      scope: SHEETS_SCOPE,
      aud: GOOGLE_TOKEN_URL,
      iat,
      exp: iat + 3600,
    });
    expect(cryptoVerify("RSA-SHA256", Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
    expect(cryptoVerify("RSA-SHA256", Buffer.from(`${header}.${claims}x`), publicKey, Buffer.from(signature, "base64url"))).toBe(false);
    expect(jwt).not.toMatch(/[+/=]/);
  });

  it("token request is the JWT-bearer form post; the response parser is strict", () => {
    const req = buildTokenRequest("a.b.c");
    expect(req.url).toBe("https://oauth2.googleapis.com/token");
    expect(req.init.method).toBe("POST");
    expect((req.init.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(req.init.body).toBe("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=a.b.c");
    expect(parseTokenResponse({ access_token: "ya29.x", expires_in: 3599, token_type: "Bearer" })).toEqual({ accessToken: "ya29.x", expiresInSec: 3599 });
    expect(parseTokenResponse({ error: "invalid_grant" })).toBeNull();
    expect(parseTokenResponse({ access_token: "", expires_in: 10 })).toBeNull();
    expect(tokenCacheKey("int1")).toBe("integrations2:sheets:token:int1");
  });
});

describe("spreadsheet requests", () => {
  const target = { spreadsheetId: "1AbC_dEf-GhIjKlMnOpQrStUvWxYz0123456789", sheetName: "Leads 2026", accessToken: "tok" };

  it("parseSpreadsheetId / sheetRange", () => {
    expect(parseSpreadsheetId(`https://docs.google.com/spreadsheets/d/${target.spreadsheetId}/edit#gid=0`)).toBe(target.spreadsheetId);
    expect(parseSpreadsheetId(` ${target.spreadsheetId} `)).toBe(target.spreadsheetId);
    expect(parseSpreadsheetId("https://docs.google.com/document/d/abc")).toBeNull();
    expect(parseSpreadsheetId("short")).toBeNull();
    expect(sheetRange("Leads", "A1")).toBe("'Leads'!A1");
    expect(sheetRange("O'quv", "1:1")).toBe("'O''quv'!1:1");
  });

  it("append / header read / header write / add sheet", () => {
    const append = buildAppendRequest({ ...target, row: ["a", "b"] });
    expect(append.url).toBe(
      `https://sheets.googleapis.com/v4/spreadsheets/${target.spreadsheetId}/values/${encodeURIComponent("'Leads 2026'!A1")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
    );
    expect(append.init.method).toBe("POST");
    expect(append.init.headers).toEqual({ Authorization: "Bearer tok", "Content-Type": "application/json" });
    expect(JSON.parse(append.init.body as string)).toEqual({ majorDimension: "ROWS", values: [["a", "b"]] });

    const read = buildHeaderReadRequest(target);
    expect(read.init.method).toBe("GET");
    expect(read.url).toContain(`/values/${encodeURIComponent("'Leads 2026'!1:1")}?majorDimension=ROWS`);
    expect(read.init.headers).toEqual({ Authorization: "Bearer tok" });

    const write = buildHeaderWriteRequest({ ...target, headers: SHEET_HEADERS });
    expect(write.init.method).toBe("PUT");
    expect(write.url).toContain(`/values/${encodeURIComponent("'Leads 2026'!A1")}?valueInputOption=RAW`);
    expect(JSON.parse(write.init.body as string).values[0]).toEqual([...SHEET_HEADERS]);

    const add = buildAddSheetRequest(target);
    expect(add.url).toBe(`https://sheets.googleapis.com/v4/spreadsheets/${target.spreadsheetId}:batchUpdate`);
    expect(JSON.parse(add.init.body as string)).toEqual({ requests: [{ addSheet: { properties: { title: "Leads 2026" } } }] });
  });
});

describe("classifySheetsError", () => {
  it("maps statuses and includes the share hint with the client email", () => {
    expect(classifySheetsError(401).kind).toBe("auth");
    const perm = classifySheetsError(403, { error: { status: "PERMISSION_DENIED", message: "The caller does not have permission" } }, "bot@demo.iam.gserviceaccount.com");
    expect(perm.kind).toBe("permission");
    expect(perm.message).toContain("bot@demo.iam.gserviceaccount.com");
    expect(perm.message).toContain("Share");
    expect(perm.message).toContain("PERMISSION_DENIED: The caller does not have permission");
    expect(classifySheetsError(404).kind).toBe("config");
    expect(classifySheetsError(429).kind).toBe("retry");
    expect(classifySheetsError(503, "upstream").message).toContain("(upstream)");
    expect(classifySheetsError(400, { error: { message: "Unable to parse range" } })).toEqual({ kind: "dead", message: "Google Sheets rad etdi (HTTP 400) (Unable to parse range)" });
  });
});

describe("rows", () => {
  it("payloadToRow aligns with SHEET_HEADERS", () => {
    expect(SHEET_HEADERS).toEqual([
      "event_at", "event", "lead_id", "name", "phone", "ig_username", "product", "score", "temperature", "source",
      "channel", "campaign", "keyword", "ad_id", "ref", "tags", "stage", "summary", "conversation_url", "is_test",
    ]);
    const row = payloadToRow(sampleEvent("lead.hot"));
    expect(row).toHaveLength(SHEET_HEADERS.length);
    const byHeader = Object.fromEntries(SHEET_HEADERS.map((h, i) => [h, row[i]]));
    expect(byHeader).toEqual({
      event_at: "2026-10-16T14:05:00+05:00",
      event: "lead.hot",
      lead_id: "lead_sample01",
      name: "Dilnoza Karimova",
      phone: "+998901234567",
      ig_username: "dilnoza.k",
      product: "IELTS kursi",
      score: "72",
      temperature: "HOT",
      source: "campaign",
      channel: "ad",
      campaign: "Kuzgi aksiya",
      keyword: "ielts",
      ad_id: "120210000000000001",
      ref: "kuz26",
      tags: "ielts, hot",
      stage: "",
      summary: "Narxni so'radi, dekabrgacha boshlamoqchi",
      conversation_url: "https://app.socialauto.uz/inbox?conversation=conv_sample01",
      is_test: "ha",
    });
    const broadcast = payloadToRow({ ...sampleEvent("broadcast.completed"), is_test: false });
    expect(broadcast.filter(Boolean)).toEqual(["2026-10-16T14:05:00+05:00", "broadcast.completed", "yo'q"]);
    expect(payloadToRow(sampleEvent("deal.stage_changed"))[SHEET_HEADERS.indexOf("stage")]).toBe("Taklif yuborildi");
  });

  it("formatTashkent and headersMatch", () => {
    expect(formatTashkent("2026-12-31T20:30:00.000Z")).toBe("2027-01-01T01:30:00+05:00");
    expect(formatTashkent("garbage")).toBe("garbage");
    expect(headersMatch([...SHEET_HEADERS])).toBe(true);
    expect(headersMatch([...SHEET_HEADERS.map((h) => h.toUpperCase()), "extra"])).toBe(true);
    expect(headersMatch(SHEET_HEADERS.slice(0, 5))).toBe(false);
    expect(headersMatch(null)).toBe(false);
    expect(headersMatch(["event", ...SHEET_HEADERS.slice(1)])).toBe(false);
  });
});
