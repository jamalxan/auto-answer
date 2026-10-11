// Times Instagram Graph conversation-list variants from inside the web
// container (token decrypted the same way the app does). Prints timings only.
import { createDecipheriv } from "node:crypto";
import pg from "pg";

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const { rows } = await client.query('SELECT "instagramId", "accessToken" FROM "InstagramAccount" LIMIT 1');
await client.end();
const { instagramId, accessToken } = rows[0];

function decrypt(b64) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, "hex");
  const buf = Buffer.from(b64, "base64");
  const iv = buf.subarray(0, 16), tag = buf.subarray(16, 32), data = buf.subarray(32);
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
const token = decrypt(accessToken);
const base = `https://graph.instagram.com/${process.env.META_GRAPH_API_VERSION ?? "v25.0"}`;

const variants = {
  "current (participants+last msg, 50)": "participants,updated_time,messages.limit(1){message,from,created_time}&limit=50",
  "no messages, 50": "participants,updated_time&limit=50",
  "current, 20": "participants,updated_time,messages.limit(1){message,from,created_time}&limit=20",
  "no messages, 20": "participants,updated_time&limit=20",
};
for (const [name, q] of Object.entries(variants)) {
  for (let i = 0; i < 2; i++) {
    const t0 = Date.now();
    const r = await fetch(`${base}/${instagramId}/conversations?platform=instagram&fields=${q}&access_token=${token}`);
    const j = await r.json();
    console.log(`${String(Date.now() - t0).padStart(5)}ms ${r.status} n=${j.data?.length ?? "-"} ${name}`);
  }
}
