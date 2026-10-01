// Setarile publice ale aplicatiei. Fisierul ajunge in browser, deci aici nu
// intra nimic cu adevarat secret: cheia privata VAPID si CRON_TOKEN stau doar
// ca secrete ale functiei edge, in Supabase.
//
// De completat o singura data: projectRef este subdomeniul proiectului
// Supabase, din URL-ul dashboardului (/project/<projectRef>).
window.DWATER_CONFIG = {
  projectRef: "PUNE_AICI_REF_UL",
  appToken: "J7UZ7bOOyIX0a0ccY8QoRO6YrSBIyHjd",
  vapidPublicKey: "BPPIDdze4tSsYQDziCM-_SSpgA16b6jCIz0P8zxGqAyeeHamGA833P--9ytk2a6DVVLEQJcLjwxqEfplys7DHzI",
};
