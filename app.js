(() => {
  "use strict";

  const CFG = window.DWATER_CONFIG || {};
  const API = CFG.projectRef && CFG.projectRef !== "PUNE_AICI_REF_UL"
    ? `https://${CFG.projectRef}.supabase.co/functions/v1/water`
    : null;

  const PUSH_SUPPORTED = "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  // On iOS, web push only works once the app sits on the home screen.
  const STANDALONE = window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true;
  const IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

  const $ = (id) => document.getElementById(id);
  const DAY_LETTERS = ["D", "L", "Ma", "Mi", "J", "V", "S"];

  let registration = null;
  let latest = null;
  let busy = false;

  // ---------- plumbing ----------

  function setView(view) {
    document.body.dataset.view = view;
  }

  function toast(text, ms = 2600) {
    const el = $("toast");
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove("show"), ms);
  }

  async function api(action, extra = {}) {
    if (!API) throw new Error("config.js nu are projectRef");
    const res = await fetch(API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-app-token": CFG.appToken || "",
      },
      body: JSON.stringify({ action, ...extra }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function urlB64ToUint8Array(base64) {
    const padded = (base64 + "=".repeat((4 - base64.length % 4) % 4))
      .replace(/-/g, "+")
      .replace(/_/g, "/");
    const raw = atob(padded);
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  // ---------- rendering ----------

  function render(status) {
    latest = status;
    try {
      localStorage.setItem("dwater.status", JSON.stringify(status));
    } catch { /* private mode: the UI works without the cache */ }

    const { today, goal } = status;

    $("count").textContent = String(today);
    $("goal").textContent = `din ${goal}`;
    $("clock").textContent = status.local_time;

    document.getElementById("water").style.setProperty(
      "--level",
      String(Math.min(1, goal ? today / goal : 0)),
    );

    const glasses = $("glasses");
    glasses.innerHTML = "";
    for (let i = 0; i < goal; i++) {
      const drop = document.createElement("i");
      if (i < today) drop.className = "on";
      glasses.appendChild(drop);
    }

    const line = $("statusLine");
    const drink = $("drink");
    line.classList.toggle("pending", Boolean(status.pending));
    drink.classList.toggle("pulse", Boolean(status.pending));

    if (status.pending) {
      line.textContent = status.reminders_sent > 1
        ? `Reminder ${status.reminders_sent} — te așteaptă un pahar 💗`
        : "Te așteaptă un pahar de apă 💗";
    } else if (today >= goal) {
      line.textContent = "Ai băut tot ce trebuia azi! 🎉";
    } else if (status.quiet) {
      line.textContent = `Noapte liniștită 🌙 următorul reminder la ${status.quiet_hours[1]}`;
    } else {
      line.textContent = `Următorul reminder la ${status.next_slot}`;
    }

    renderTimeline(status.timeline || [], status.extras || []);
    renderWeek(status.week, goal);
    renderDiag(status);
  }

  const TIMELINE_TEXT = {
    done: (at) => (at ? `băut la ${at}` : "băut"),
    missed: () => "nu a fost bifat",
    pending: () => "acum — bea un pahar",
    upcoming: () => "urmează",
  };

  function renderTimeline(timeline, extras) {
    const list = $("timeline");
    list.innerHTML = "";

    for (const entry of timeline) {
      const row = document.createElement("li");
      row.className = entry.state;

      const when = document.createElement("span");
      when.className = "when";
      when.textContent = entry.slot;

      const dot = document.createElement("span");
      dot.className = "dot";

      const what = document.createElement("span");
      what.className = "what";
      what.textContent = TIMELINE_TEXT[entry.state](entry.at);

      row.append(when, dot, what);
      list.appendChild(row);
    }

    $("extras").textContent = extras.length
      ? `Pahare în plus: ${extras.join(", ")}`
      : "";
  }

  function renderWeek(week, goal) {
    const box = $("week");
    box.innerHTML = "";
    week.forEach((day, i) => {
      const cell = document.createElement("div");
      cell.className = "day" + (i === week.length - 1 ? " today" : "");

      const bar = document.createElement("div");
      bar.className = "bar";
      const fill = document.createElement("span");
      // A day with nothing logged still gets a sliver, so the bar reads as a bar.
      fill.style.height = day.count
        ? `${Math.max(10, Math.min(100, (day.count / goal) * 100))}%`
        : "0%";
      bar.appendChild(fill);

      const num = document.createElement("div");
      num.className = "num";
      num.textContent = String(day.count);

      const label = document.createElement("small");
      label.textContent = DAY_LETTERS[new Date(`${day.date}T12:00:00Z`).getUTCDay()];

      cell.append(num, bar, label);
      box.appendChild(cell);
    });
  }

  function renderDiag(status) {
    const rows = {
      "Ora locală": status.local_time,
      "Următorul slot": status.next_slot,
      "Orarul": status.slots.join(" · "),
      "Liniște": `${status.quiet_hours[0]} – ${status.quiet_hours[1]}`,
      "Dispozitive abonate": String(status.devices),
      "Permisiune": "Notification" in window ? Notification.permission : "nesuportat",
      "Pe ecran principal": STANDALONE ? "da" : "nu",
    };
    const dl = $("diag");
    dl.innerHTML = "";
    for (const [key, value] of Object.entries(rows)) {
      const dt = document.createElement("dt");
      dt.textContent = key;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
  }

  function burstHearts() {
    const box = $("hearts");
    const emojis = ["💗", "💖", "💕", "✨", "💓"];
    for (let i = 0; i < 6; i++) {
      const heart = document.createElement("i");
      heart.textContent = emojis[i % emojis.length];
      heart.style.setProperty("--dx", `${(Math.random() - 0.5) * 120}px`);
      heart.style.animationDelay = `${i * 70}ms`;
      box.appendChild(heart);
      setTimeout(() => heart.remove(), 1800 + i * 70);
    }
  }

  // Once she has confirmed, the reminders already on screen are noise.
  async function clearNotifications() {
    try {
      if (registration) {
        const shown = await registration.getNotifications();
        shown.forEach((n) => n.close());
      }
      if ("clearAppBadge" in navigator) await navigator.clearAppBadge();
    } catch { /* not supported everywhere, and never important enough to fail */ }
  }

  // ---------- actions ----------

  async function drink() {
    if (busy) return;
    busy = true;
    const button = $("drink");
    button.disabled = true;

    burstHearts();
    if (latest) {
      // Show the new count immediately; the server response confirms it.
      render({
        ...latest,
        today: latest.today + 1,
        pending: false,
        reminders_sent: 0,
        timeline: (latest.timeline || []).map((entry) =>
          entry.state === "pending" ? { ...entry, state: "done" } : entry
        ),
      });
    }
    clearNotifications();

    try {
      render(await api("confirm"));
      toast("Bravo! 💗");
    } catch (err) {
      toast(`Nu s-a salvat: ${err.message}`);
      refresh();
    } finally {
      busy = false;
      button.disabled = false;
    }
  }

  async function ensureSubscription() {
    if (!registration) return;
    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(CFG.vapidPublicKey),
      });
    }
    // Upsert every time, so a wiped database heals itself on next open.
    await api("subscribe", {
      subscription: sub.toJSON(),
      label: `${IOS ? "iPhone" : "browser"} · ${navigator.language}`,
    });
  }

  async function enable() {
    const hint = $("enableHint");
    const button = $("enable");
    button.disabled = true;
    hint.textContent = "Se activează…";

    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        hint.textContent = "Permisiunea nu a fost acordată.";
        button.disabled = false;
        if (permission === "denied") setView("blocked");
        return;
      }
      await ensureSubscription();
      const status = await api("status");
      render(status);
      setView("ready");
      toast("Notificările sunt active 💗");
    } catch (err) {
      hint.textContent = `Eroare: ${err.message}`;
      button.disabled = false;
    }
  }

  async function refresh() {
    try {
      render(await api("status"));
      if (document.body.dataset.view === "error") decideView();
    } catch (err) {
      if (!latest) {
        $("errorText").textContent = err.message;
        setView("error");
      }
    }
  }

  function decideView() {
    if (!PUSH_SUPPORTED) {
      if (STANDALONE) {
        $("errorText").textContent =
          "Acest iPhone are nevoie de iOS 16.4 sau mai nou pentru notificări web.";
        setView("error");
      } else {
        setView("install");
      }
      return;
    }
    if (Notification.permission === "granted") {
      setView("ready");
    } else if (Notification.permission === "denied") {
      setView("blocked");
    } else if (IOS && !STANDALONE) {
      setView("install");
    } else {
      setView("enable");
    }
  }

  // ---------- boot ----------

  async function boot() {
    if (!API) {
      $("errorText").textContent =
        "config.js nu are încă ref-ul proiectului Supabase.";
      setView("error");
      return;
    }

    // Paint cached numbers first so the app never looks empty on a slow network.
    try {
      const cached = localStorage.getItem("dwater.status");
      if (cached) render(JSON.parse(cached));
    } catch { /* ignore */ }

    if ("serviceWorker" in navigator) {
      try {
        registration = await navigator.serviceWorker.register("./sw.js");
      } catch (err) {
        console.error("service worker registration failed", err);
      }
    }

    decideView();

    try {
      render(await api("status"));
    } catch (err) {
      if (!latest) {
        $("errorText").textContent = err.message;
        setView("error");
        return;
      }
      toast("Offline – afișez ultimele date salvate");
    }

    if (PUSH_SUPPORTED && Notification.permission === "granted") {
      ensureSubscription().catch((err) => console.error("subscribe failed", err));
      clearNotifications();
    }
  }

  $("drink").addEventListener("click", drink);
  $("enable").addEventListener("click", enable);
  $("recheck").addEventListener("click", () => location.reload());
  $("retry").addEventListener("click", () => location.reload());
  $("refresh").addEventListener("click", () => {
    toast("Se reîncarcă…", 1200);
    refresh();
  });
  $("testPush").addEventListener("click", async () => {
    try {
      const { results } = await api("test");
      toast(results.length ? "Trimis! Verifică notificările 💗" : "Niciun dispozitiv abonat");
    } catch (err) {
      toast(`Eroare: ${err.message}`);
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refresh();
      clearNotifications();
    }
  });

  // The service worker pings us when a reminder arrives while the app is open.
  navigator.serviceWorker?.addEventListener("message", (event) => {
    if (event.data?.type === "water-push") refresh();
  });

  boot();
})();
