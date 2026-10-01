// Generates a VAPID key pair and the two access tokens, then writes:
//   config.js         - the public half, served to the browser
//   SECRETE.local.md  - the full list, git-ignored, to copy into Supabase
//
//   node tools/new-keys.mjs
//
// Re-running this replaces the keys. Every device then has to turn
// notifications on again, so only do it if a key leaked.

import { generateKeyPairSync, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// VAPID keys are a plain P-256 pair: the public half as an uncompressed
// point, the private half as the raw scalar, both base64url.
const { publicKey, privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
});
const pub = publicKey.export({ format: "jwk" });
const priv = privateKey.export({ format: "jwk" });

const keys = {
  VAPID_PUBLIC_KEY: Buffer.concat([
    Buffer.from([4]),
    Buffer.from(pub.x, "base64url"),
    Buffer.from(pub.y, "base64url"),
  ]).toString("base64url"),
  VAPID_PRIVATE_KEY: priv.d,
  APP_TOKEN: randomBytes(24).toString("base64url"),
  CRON_TOKEN: randomBytes(24).toString("base64url"),
};

// Keep whatever project ref is already configured.
const configPath = join(ROOT, "config.js");
let projectRef = "PUNE_AICI_REF_UL";
if (existsSync(configPath)) {
  const found = /projectRef:\s*"([^"]*)"/.exec(readFileSync(configPath, "utf8"));
  if (found && found[1]) projectRef = found[1];
}

writeFileSync(
  configPath,
  `// Setarile publice ale aplicatiei. Fisierul ajunge in browser, deci aici nu
// intra nimic cu adevarat secret: cheia privata VAPID si CRON_TOKEN stau doar
// ca secrete ale functiei edge, in Supabase.
//
// De completat o singura data: projectRef este subdomeniul proiectului
// Supabase, din URL-ul dashboardului (/project/<projectRef>).
window.DWATER_CONFIG = {
  projectRef: ${JSON.stringify(projectRef)},
  appToken: ${JSON.stringify(keys.APP_TOKEN)},
  vapidPublicKey: ${JSON.stringify(keys.VAPID_PUBLIC_KEY)},
};
`,
);

writeFileSync(
  join(ROOT, "SECRETE.local.md"),
  `# Secretele dwater

Fisierul NU ajunge pe GitHub (e in .gitignore). Tine-l local.
Generat la ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.

## 1. Edge Function Secrets in Supabase

Dashboard -> Project Settings -> Edge Functions -> Secrets

| Nume | Valoare |
| --- | --- |
| VAPID_PUBLIC_KEY | \`${keys.VAPID_PUBLIC_KEY}\` |
| VAPID_PRIVATE_KEY | \`${keys.VAPID_PRIVATE_KEY}\` |
| VAPID_SUBJECT | \`mailto:...\` adresa ta de email |
| APP_TOKEN | \`${keys.APP_TOKEN}\` |
| CRON_TOKEN | \`${keys.CRON_TOKEN}\` |

## 2. In supabase/migrations/0002_cron.sql

Inainte de a-l rula in SQL Editor, inlocuieste:

- \`PROJECT_REF\` -> ref-ul proiectului Supabase
- \`CRON_TOKEN\` -> \`${keys.CRON_TOKEN}\`

## 3. In config.js

appToken si vapidPublicKey sunt deja scrise. Mai lipseste doar \`projectRef\`.
`,
);

console.log("config.js            <- appToken + vapidPublicKey");
console.log("SECRETE.local.md     <- toate valorile, pentru Supabase");
console.log(`projectRef pastrat:  ${projectRef}`);
