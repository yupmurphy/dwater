// Proves push.js implements RFC 8291/8292 correctly, in two steps:
//
//   1. the reference library web-push encrypts a message, and our decryptor
//      reads it back -> our key derivation matches a real-world sender;
//   2. our encryptor produces a message that same (now trusted) decryptor
//      reads back -> our sender agrees with it too.
//
// Plus a check that the VAPID JWT verifies against the public key.
//
// Run with: npm test   (from the repository root)

import assert from "node:assert/strict";
import webpush from "web-push";
import { webcrypto } from "node:crypto";

import {
  b64uToBytes,
  bytesToB64u,
  decryptPayload,
  encryptPayload,
  vapidHeader,
} from "./push.js";

const VAPID = {
  publicKey: null,
  privateKey: null,
  subject: "mailto:test@example.com",
};

// A stand-in for what a browser hands us when it subscribes.
async function fakeSubscriber() {
  const pair = await webcrypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.privateKey);
  const raw = new Uint8Array(
    await webcrypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    p256dh: bytesToB64u(raw),
    auth: bytesToB64u(webcrypto.getRandomValues(new Uint8Array(16))),
    endpoint: "https://web.push.apple.com/test-endpoint",
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("generated VAPID keys have the expected shape", () => {
  const keys = webpush.generateVAPIDKeys();
  VAPID.publicKey = keys.publicKey;
  VAPID.privateKey = keys.privateKey;
  assert.equal(b64uToBytes(VAPID.publicKey).length, 65);
  assert.equal(b64uToBytes(VAPID.publicKey)[0], 4);
  assert.equal(b64uToBytes(VAPID.privateKey).length, 32);
});

test("decrypts a body produced by the web-push reference library", async () => {
  const sub = await fakeSubscriber();
  const message = JSON.stringify({ title: "Apa", body: "Bea un pahar" });

  webpush.setVapidDetails(VAPID.subject, VAPID.publicKey, VAPID.privateKey);
  const details = webpush.generateRequestDetails(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    message,
  );

  assert.equal(details.headers["Content-Encoding"], "aes128gcm");
  const plaintext = await decryptPayload(
    new Uint8Array(details.body),
    sub.privateJwk,
    sub.auth,
  );
  assert.equal(plaintext, message);
});

test("our encrypted body round-trips through that same decryptor", async () => {
  const sub = await fakeSubscriber();
  const message = JSON.stringify({
    title: "E timpul pentru apa",
    body: "Un pahar acum",
    n: 3,
  });

  const body = await encryptPayload(message, sub.p256dh, sub.auth);

  // Header layout: 16-byte salt, 4-byte record size, 1-byte key length, key.
  assert.equal(new DataView(body.buffer).getUint32(16, false), 4096);
  assert.equal(body[20], 65);
  assert.equal(body[21], 4, "sender key must be an uncompressed point");

  const plaintext = await decryptPayload(body, sub.privateJwk, sub.auth);
  assert.equal(plaintext, message);
});

test("a wrong auth secret cannot decrypt the body", async () => {
  const sub = await fakeSubscriber();
  const body = await encryptPayload("secret", sub.p256dh, sub.auth);
  const wrongAuth = bytesToB64u(webcrypto.getRandomValues(new Uint8Array(16)));
  await assert.rejects(() => decryptPayload(body, sub.privateJwk, wrongAuth));
});

test("the VAPID header carries a JWT that verifies", async () => {
  const endpoint = "https://web.push.apple.com/some/path?x=1";
  const header = await vapidHeader(
    endpoint,
    VAPID.publicKey,
    VAPID.privateKey,
    VAPID.subject,
  );

  const match = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=(.+)$/.exec(header);
  assert.ok(match, `unexpected header format: ${header}`);
  const [, jwt, k] = match;
  assert.equal(k, VAPID.publicKey);

  const [h, c, s] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), {
    typ: "JWT",
    alg: "ES256",
  });

  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.aud, "https://web.push.apple.com", "aud is the origin only");
  assert.equal(claims.sub, VAPID.subject);
  const hoursOut = (claims.exp - Date.now() / 1000) / 3600;
  assert.ok(hoursOut > 11 && hoursOut < 24, `exp ${hoursOut}h out of range`);

  const raw = b64uToBytes(VAPID.publicKey);
  const key = await webcrypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      x: bytesToB64u(raw.slice(1, 33)),
      y: bytesToB64u(raw.slice(33)),
    },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const ok = await webcrypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64uToBytes(s),
    new TextEncoder().encode(`${h}.${c}`),
  );
  assert.ok(ok, "JWT signature did not verify");
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}`);
    console.log(`     ${err.message}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
