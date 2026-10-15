// Prints a DEVELOPER_PASSWORD_HASH value for the /developer login.
// Usage: node scripts/hash-developer-password.mjs            (prompts)
//        node scripts/hash-developer-password.mjs <password>
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";

let password = process.argv[2];
if (!password) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  password = await rl.question("Developer password: ");
  rl.close();
}
if (!password || password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64);
console.log(`${salt.toString("hex")}:${hash.toString("hex")}`);
