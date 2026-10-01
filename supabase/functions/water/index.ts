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
import { sendPush } from "./push.js";

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
