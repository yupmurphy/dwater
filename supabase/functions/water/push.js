// Web Push (RFC 8291 "aes128gcm" + RFC 8292 VAPID) on plain Web Crypto.
// No npm dependencies, so it runs unchanged on Deno (Supabase Edge Functions)
// and on Node, which is how the test suite exercises it.

const enc = new TextEncoder();

export function b64uToBytes(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64u(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

// HKDF-Extract plus a single-block HKDF-Expand, which is all aes128gcm needs:
// every output here is at most 32 bytes.
async function hkdf(salt, ikm, info, length) {
  const prk = await hmac(salt, ikm);
  const okm = await hmac(prk, concat(info, new Uint8Array([1])));
  return okm.slice(0, length);
}

function rawToJwk(raw) {
  if (raw.length !== 65 || raw[0] !== 4) {
    throw new Error("expected a 65-byte uncompressed P-256 point");
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64u(raw.slice(1, 33)),
    y: bytesToB64u(raw.slice(33, 65)),
    ext: true,
  };
}

// Derives the content encryption key and nonce shared by sender and receiver.
// asPublic is the sender's ephemeral public key, uaPublic the subscriber's.
async function deriveKeys({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const keyInfo = concat(
    enc.encode("WebPush: info"),
    new Uint8Array([0]),
    uaPublic,
    asPublic,
  );
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    concat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0])),
    12,
  );
  return { cek, nonce };
}

const RECORD_SIZE = 4096;

// Encrypts payload for one subscription and returns the aes128gcm body:
// salt | record size | key id length | sender public key | ciphertext
export async function encryptPayload(payload, p256dhB64u, authB64u) {
  const uaPublic = b64uToBytes(p256dhB64u);
  const authSecret = b64uToBytes(authB64u);
  const plaintext = typeof payload === "string" ? enc.encode(payload) : payload;

  if (plaintext.length + 17 > RECORD_SIZE) {
    throw new Error("payload too large for a single record");
  }

  const as = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const asPublic = new Uint8Array(
    await crypto.subtle.exportKey("raw", as.publicKey),
  );

  const uaKey = await crypto.subtle.importKey(
    "jwk",
    rawToJwk(uaPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      as.privateKey,
      256,
    ),
  );

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const { cek, nonce } = await deriveKeys({
    ecdhSecret,
    authSecret,
    uaPublic,
    asPublic,
    salt,
  });

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 is the padding delimiter that marks the final record.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      concat(plaintext, new Uint8Array([2])),
    ),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = asPublic.length;

  return concat(header, asPublic, ciphertext);
}

// The receiver's half of RFC 8291. Only the tests use it, but keeping it beside
// the encryptor is what lets them prove the two halves agree.
export async function decryptPayload(body, uaPrivateJwk, authB64u) {
  const salt = body.slice(0, 16);
  const idLen = body[20];
  const asPublic = body.slice(21, 21 + idLen);
  const ciphertext = body.slice(21 + idLen);

  const uaPrivate = await crypto.subtle.importKey(
    "jwk",
    { ...uaPrivateJwk, key_ops: ["deriveBits"] },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const asKey = await crypto.subtle.importKey(
    "jwk",
    rawToJwk(asPublic),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: asKey },
      uaPrivate,
      256,
    ),
  );

  const uaPublic = concat(
    new Uint8Array([4]),
    b64uToBytes(uaPrivateJwk.x),
    b64uToBytes(uaPrivateJwk.y),
  );
  const { cek, nonce } = await deriveKeys({
    ecdhSecret,
    authSecret: b64uToBytes(authB64u),
    uaPublic,
    asPublic,
    salt,
  });

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      aesKey,
      ciphertext,
    ),
  );

  // Drop the trailing zero padding, then the padding delimiter itself.
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  return new TextDecoder().decode(padded.slice(0, end));
}

// Signs a VAPID JWT for the push service that owns endpoint.
export async function vapidHeader(
  endpoint,
  publicKeyB64u,
  privateKeyB64u,
  subject,
  ttlSeconds = 12 * 3600,
) {
  const aud = new URL(endpoint).origin;
  const jwk = {
    ...rawToJwk(b64uToBytes(publicKeyB64u)),
    d: privateKeyB64u,
    key_ops: ["sign"],
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const header = bytesToB64u(
    enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = bytesToB64u(
    enc.encode(JSON.stringify({
      aud,
      exp: Math.floor(Date.now() / 1000) + ttlSeconds,
      sub: subject,
    })),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      enc.encode(`${header}.${claims}`),
    ),
  );

  return `vapid t=${header}.${claims}.${bytesToB64u(signature)}, k=${publicKeyB64u}`;
}

// Builds and sends one push message. Returns the push service's HTTP status.
export async function sendPush({
  subscription,
  payload,
  vapid,
  ttl = 1800,
  urgency = "high",
}) {
  const body = await encryptPayload(
    payload,
    subscription.p256dh,
    subscription.auth,
  );
  const authorization = await vapidHeader(
    subscription.endpoint,
    vapid.publicKey,
    vapid.privateKey,
    vapid.subject,
  );

  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });

  return {
    status: res.status,
    detail: res.ok ? "" : (await res.text().catch(() => "")).slice(0, 200),
  };
}
