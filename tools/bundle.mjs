// Inlines push.js into index.ts so the whole edge function is one file that
// can be pasted into the Supabase dashboard editor. The CLI does not need
// this - it uploads the directory as it stands.
//
//   node tools/bundle.mjs   ->  dist/water-function.ts

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FN = join(ROOT, "supabase", "functions", "water");

const IMPORT_LINE = 'import { sendPush } from "./push.js";';

const index = readFileSync(join(FN, "index.ts"), "utf8");
if (!index.includes(IMPORT_LINE)) {
  throw new Error(`index.ts no longer contains: ${IMPORT_LINE}`);
}

const push = readFileSync(join(FN, "push.js"), "utf8")
  .replace(/^export /gm, "")
  .trim();

const bundled = index.replace(
  IMPORT_LINE,
  [
    "// ---------------------------------------------------------------",
    "// Inlined from push.js by tools/bundle.mjs - edit that file, not this.",
    "// ---------------------------------------------------------------",
    push,
    "// --------------------------- end push.js -------------------------",
  ].join("\n"),
);

mkdirSync(join(ROOT, "dist"), { recursive: true });
writeFileSync(join(ROOT, "dist", "water-function.ts"), bundled);

console.log(
  `dist/water-function.ts  ${bundled.split("\n").length} lines, ` +
    `${(Buffer.byteLength(bundled) / 1024).toFixed(1)} KB`,
);
