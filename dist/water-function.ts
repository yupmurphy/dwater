// dwater - the whole backend for the water reminder.
//
// Actions (POST, JSON body {"action": ...} or /water/<action>):
//   status       what the app shows: today's count, goal, next slot, streak
//   subscribe    store an iPhone push subscription
//   unsubscribe  drop one
//   confirm      log a glass and stop the current round of reminders
//   test         send one push right now, to check the plumbing
//   tick         called every minute by pg_cron; decides whether to push
//
// status/subscribe/unsubscribe/confirm/test authenticate with x-app-token,
// which ships inside the public web app and is therefore not a real secret:
// it only keeps strangers from poking the endpoint by accident. tick needs
// x-cron-token, which never leaves the database, so nobody can make the app
// send pushes.

import { createClient } from "npm:@supabase/supabase-js@2";
// ---------------------------------------------------------------
// Inlined from push.js by tools/bundle.mjs - edit that file, not this.
// ---------------------------------------------------------------
// Web Push (RFC 8291 "aes128gcm" + RFC 8292 VAPID) on plain Web Crypto.
// No npm dependencies, so it runs unchanged on Deno (Supabase Edge Functions)
// and on Node, which is how the test suite exercises it.

const enc = new TextEncoder();

function b64uToBytes(s) {
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes) {
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
async function encryptPayload(payload, p256dhB64u, authB64u) {
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
async function decryptPayload(body, uaPrivateJwk, authB64u) {
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
async function vapidHeader(
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
async function sendPush({
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
// --------------------------- end push.js -------------------------

const APP_TOKEN = Deno.env.get("APP_TOKEN") ?? "";
const CRON_TOKEN = Deno.env.get("CRON_TOKEN") ?? "";

const VAPID = {
  publicKey: Deno.env.get("VAPID_PUBLIC_KEY") ?? "",
  privateKey: Deno.env.get("VAPID_PRIVATE_KEY") ?? "",
  subject: Deno.env.get("VAPID_SUBJECT") ?? "mailto:dwater@example.com",
};

// Older projects inject SUPABASE_SERVICE_ROLE_KEY; newer ones a JSON map of
// secret keys. Accept either so this works whenever the project was created.
function serviceKey(): string {
  const direct = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (direct) return direct;
  const bundle = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (bundle) {
    try {
      const parsed = JSON.parse(bundle);
      return parsed.default ?? Object.values(parsed)[0] as string;
    } catch { /* fall through to the error below */ }
  }
  throw new Error("no service key available in the function environment");
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey(), {
  auth: { persistSession: false },
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-app-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Settings = {
  timezone: string;
  slots: number[];
  repeat_minutes: number;
  max_repeats: number;
  quiet_start: number;
  quiet_end: number;
  grace_minutes: number;
  daily_goal: number;
};

type State = {
  slot_date: string | null;
  slot_minute: number | null;
  reminders_sent: number;
  last_sent_at: string | null;
  confirmed: boolean;
};

// Wall-clock date and minutes-since-midnight in the configured timezone, so
// daylight saving is handled by the runtime rather than by arithmetic.
function localNow(tz: string, at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);

  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

function hhmm(minutes: number) {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

// Quiet hours wrap around midnight (23:00 -> 07:00), hence the two cases.
function isQuiet(minutes: number, start: number, end: number) {
  return start > end
    ? minutes >= start || minutes < end
    : minutes >= start && minutes < end;
}

function activeSlot(slots: number[], minutes: number): number | null {
  const past = slots.filter((s) => s <= minutes);
  return past.length ? Math.max(...past) : null;
}

function nextSlot(slots: number[], minutes: number): number {
  const ahead = slots.filter((s) => s > minutes);
  return ahead.length ? Math.min(...ahead) : Math.min(...slots);
}

async function loadConfig() {
  const [settings, state] = await Promise.all([
    db.from("water_settings").select("*").eq("id", 1).single(),
    db.from("water_state").select("*").eq("id", 1).single(),
  ]);
  if (settings.error) throw settings.error;
  if (state.error) throw state.error;
  return {
    settings: settings.data as Settings,
    state: state.data as State,
  };
}

async function countForDate(date: string) {
  const { count, error } = await db
    .from("water_log")
    .select("*", { count: "exact", head: true })
    .eq("local_date", date);
  if (error) throw error;
  return count ?? 0;
}

async function recentDates(from: string) {
  const { data, error } = await db
    .from("water_log")
    .select("local_date")
    .gte("local_date", from);
  if (error) throw error;
  const counts: Record<string, number> = {};
  for (const row of data ?? []) {
    counts[row.local_date] = (counts[row.local_date] ?? 0) + 1;
  }
  return counts;
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const FIRST_MESSAGES = [
  { title: "Timpul pentru apa 💧", body: "Un pahar de apa pentru tine 💗" },
  { title: "Pauza de apa 💧", body: "Bea un pahar si bifeaza in aplicatie" },
  { title: "Apa, iubito 💗", body: "Un pahar acum si gata" },
];

const REPEAT_MESSAGES = [
  { title: "Inca n-ai bifat apa 🥺", body: "Un pahar mic si apas butonul" },
  { title: "Tot te asteptam 💧", body: "Bea apa si bifeaza, te rog" },
  { title: "Reminder apa 💗", body: "Nu uita paharul de apa" },
];

async function pushToAll(message: { title: string; body: string }, extra: Record<string, unknown> = {}) {
  const { data: subs, error } = await db.from("water_subscriptions").select("*");
  if (error) throw error;

  const payload = JSON.stringify({ ...message, ...extra, at: Date.now() });
  const results: { endpoint: string; status: number }[] = [];

  for (const sub of subs ?? []) {
    try {
      const { status, detail } = await sendPush({
        subscription: {
          endpoint: sub.endpoint,
          p256dh: sub.p256dh,
          auth: sub.auth,
        },
        payload,
        vapid: VAPID,
      });
      results.push({ endpoint: sub.endpoint.slice(-12), status });

      // 404/410 mean the subscription is gone for good; anything else is
      // transient, so just keep a tally for debugging.
      if (status === 404 || status === 410) {
        await db.from("water_subscriptions").delete().eq("id", sub.id);
      } else if (status >= 200 && status < 300) {
        await db
          .from("water_subscriptions")
          .update({ last_ok_at: new Date().toISOString(), fail_count: 0 })
          .eq("id", sub.id);
      } else {
        console.error("push failed", status, detail);
        await db
          .from("water_subscriptions")
          .update({ fail_count: (sub.fail_count ?? 0) + 1 })
          .eq("id", sub.id);
      }
    } catch (err) {
      console.error("push threw", String(err));
      results.push({ endpoint: sub.endpoint.slice(-12), status: 0 });
    }
  }

  return results;
}

async function handleTick() {
  const { settings, state } = await loadConfig();
  const now = localNow(settings.timezone);

  if (isQuiet(now.minutes, settings.quiet_start, settings.quiet_end)) {
    return { action: "tick", skipped: "quiet hours", local: hhmm(now.minutes) };
  }

  const slot = activeSlot(settings.slots, now.minutes);
  if (slot === null) {
    return { action: "tick", skipped: "before the first slot", local: hhmm(now.minutes) };
  }

  let current = state;

  // A slot we have not seen yet opens a fresh round of reminders - unless she
  // drank within the grace window, in which case there is nothing to nag about.
  if (current.slot_date !== now.date || current.slot_minute !== slot) {
    const since = new Date(Date.now() - settings.grace_minutes * 60_000).toISOString();
    const { count: justDrank, error } = await db
      .from("water_log")
      .select("*", { count: "exact", head: true })
      .gte("drank_at", since);
    if (error) throw error;

    current = {
      slot_date: now.date,
      slot_minute: slot,
      reminders_sent: 0,
      last_sent_at: null,
      confirmed: (justDrank ?? 0) > 0,
    };
    await db
      .from("water_state")
      .update({ ...current, updated_at: new Date().toISOString() })
      .eq("id", 1);
  }

  if (current.confirmed) {
    return { action: "tick", skipped: "slot already satisfied", slot: hhmm(slot) };
  }

  const today = await countForDate(now.date);
  if (today >= settings.daily_goal) {
    await db
      .from("water_state")
      .update({ confirmed: true, updated_at: new Date().toISOString() })
      .eq("id", 1);
    return { action: "tick", skipped: "daily goal reached", today };
  }

  if (current.reminders_sent >= settings.max_repeats) {
    return { action: "tick", skipped: "max repeats for this slot", slot: hhmm(slot) };
  }

  if (current.last_sent_at) {
    const elapsed = Date.now() - new Date(current.last_sent_at).getTime();
    // Allow a little slack so a cron tick that lands a few seconds early
    // still counts as "5 minutes later".
    if (elapsed < settings.repeat_minutes * 60_000 - 20_000) {
      return { action: "tick", skipped: "too soon", waited_ms: elapsed };
    }
  }

  const n = current.reminders_sent + 1;
  const pool = n === 1 ? FIRST_MESSAGES : REPEAT_MESSAGES;
  const message = pool[(n - 1) % pool.length];

  const results = await pushToAll(message, {
    today,
    goal: settings.daily_goal,
    reminder: n,
  });

  await db
    .from("water_state")
    .update({
      reminders_sent: n,
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);

  return { action: "tick", sent: n, slot: hhmm(slot), results };
}

// Today, slot by slot: when she drank, and which ones went by unanswered.
async function buildTimeline(
  settings: Settings,
  state: State,
  now: { date: string; minutes: number },
  quiet: boolean,
) {
  const { data: rows, error } = await db
    .from("water_log")
    .select("drank_at, slot_minute")
    .eq("local_date", now.date)
    .order("drank_at");
  if (error) throw error;

  const drankAt = new Map<number, string>();
  const extras: string[] = [];

  for (const row of rows ?? []) {
    const at = hhmm(localNow(settings.timezone, new Date(row.drank_at)).minutes);
    // A second glass inside the same slot is a bonus, not a replacement.
    if (row.slot_minute !== null && !drankAt.has(row.slot_minute)) {
      drankAt.set(row.slot_minute, at);
    } else {
      extras.push(at);
    }
  }

  const current = activeSlot(settings.slots, now.minutes);

  const timeline = settings.slots.map((slot) => {
    if (drankAt.has(slot)) {
      return { slot: hhmm(slot), state: "done", at: drankAt.get(slot)! };
    }
    if (slot > now.minutes) return { slot: hhmm(slot), state: "upcoming", at: null };
    if (slot === current && !state.confirmed && !quiet) {
      return { slot: hhmm(slot), state: "pending", at: null };
    }
    return { slot: hhmm(slot), state: "missed", at: null };
  });

  return { timeline, extras };
}

async function handleStatus() {
  const { settings, state } = await loadConfig();
  const now = localNow(settings.timezone);
  const today = await countForDate(now.date);

  const history = await recentDates(shiftDate(now.date, -6));
  const week = Array.from({ length: 7 }, (_, i) => {
    const date = shiftDate(now.date, i - 6);
    return { date, count: history[date] ?? 0 };
  });

  const { count: subs } = await db
    .from("water_subscriptions")
    .select("*", { count: "exact", head: true });

  const quiet = isQuiet(now.minutes, settings.quiet_start, settings.quiet_end);
  const slot = activeSlot(settings.slots, now.minutes);
  const pending = !quiet &&
    slot !== null &&
    state.slot_date === now.date &&
    state.slot_minute === slot &&
    !state.confirmed &&
    today < settings.daily_goal;

  const { timeline, extras } = await buildTimeline(settings, state, now, quiet);

  return {
    today,
    goal: settings.daily_goal,
    week,
    timeline,
    extras,
    pending,
    reminders_sent: pending ? state.reminders_sent : 0,
    quiet,
    local_time: hhmm(now.minutes),
    next_slot: hhmm(nextSlot(settings.slots, now.minutes)),
    slots: settings.slots.map(hhmm),
    quiet_hours: [hhmm(settings.quiet_start), hhmm(settings.quiet_end)],
    devices: subs ?? 0,
  };
}

async function handleConfirm() {
  const { settings } = await loadConfig();
  const now = localNow(settings.timezone);

  const { error } = await db.from("water_log").insert({
    local_date: now.date,
    slot_minute: activeSlot(settings.slots, now.minutes),
  });
  if (error) throw error;

  await db
    .from("water_state")
    .update({ confirmed: true, updated_at: new Date().toISOString() })
    .eq("id", 1);

  return await handleStatus();
}

async function handleSubscribe(body: Record<string, any>) {
  const sub = body.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
    return json({ error: "subscription incomplete" }, 400);
  }

  const { error } = await db
    .from("water_subscriptions")
    .upsert(
      {
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        label: String(body.label ?? "").slice(0, 120) || null,
        fail_count: 0,
      },
      { onConflict: "endpoint" },
    );
  if (error) throw error;

  return json({ ok: true, ...(await handleStatus()) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "use POST" }, 405);

  let body: Record<string, any> = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  // pg_cron calls .../water/tick; the app posts {"action": "..."} to .../water
  const tail = new URL(req.url).pathname.split("/").filter(Boolean).pop();
  const action = (tail && tail !== "water" ? tail : body.action) ?? "status";

  try {
    if (action === "tick") {
      if (!CRON_TOKEN || req.headers.get("x-cron-token") !== CRON_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }
      return json(await handleTick());
    }

    if (!APP_TOKEN || req.headers.get("x-app-token") !== APP_TOKEN) {
      return json({ error: "unauthorized" }, 401);
    }

    switch (action) {
      case "status":
        return json(await handleStatus());
      case "confirm":
        return json(await handleConfirm());
      case "subscribe":
        return await handleSubscribe(body);
      case "unsubscribe": {
        if (!body.endpoint) return json({ error: "endpoint required" }, 400);
        await db.from("water_subscriptions").delete().eq("endpoint", body.endpoint);
        return json({ ok: true });
      }
      case "test": {
        const results = await pushToAll({
          title: "Test dwater 💗",
          body: "Notificarile functioneaza!",
        }, { test: true });
        return json({ ok: true, results });
      }
      default:
        return json({ error: `unknown action: ${action}` }, 400);
    }
  } catch (err) {
    console.error(action, err);
    return json({ error: String(err instanceof Error ? err.message : err) }, 500);
  }
});
