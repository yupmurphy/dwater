# dwater

Un reminder de apă pentru iPhone: o notificare la fiecare 2 ore și jumătate,
repetată din 5 în 5 minute până când bifezi în aplicație că ai băut. Noaptea,
între 23:00 și 07:00 (ora Chișinăului), nu sună nimic.

👉 **Setup pas cu pas: [SETUP.md](SETUP.md)**

## Cum e construit

Pe iPhone, o pagină web nu își poate programa singură notificări — nu există
echivalent pentru „sună peste 2 ore". Singura cale e **Web Push**: notificarea
vine de la un server, prin serviciul de push al Apple. De aici cele două
jumătăți:

| Parte | Unde stă | Ce face |
| --- | --- | --- |
| Aplicația (PWA) | GitHub Pages | Ce vede soția: paharele de azi, butonul de bifat, istoricul |
| Funcția `water` | Supabase Edge Functions | Decide când e cazul și trimite notificarea |
| `pg_cron` | Baza de date Supabase | Trezește funcția o dată pe minut |

Cronul rulează în fiecare minut, dar notificarea pleacă doar când funcția
decide: slot deschis, nebifat, în afara orelor de liniște, sub limita de
reluări. Toată logica stă într-un singur loc, iar orarul se schimbă dintr-un
`update` în `water_settings`, fără redeploy.

## Fișiere

```
index.html, styles.css, app.js   aplicația
sw.js                            service worker: cache offline + handler de push
config.js                        projectRef, appToken, cheia publică VAPID
manifest.webmanifest, icons/     ca să poată fi pusă pe ecranul principal

supabase/functions/water/
  index.ts                       rutele: status, subscribe, confirm, test, tick
  push.js                        Web Push (RFC 8291 + VAPID) pe Web Crypto
  push.test.mjs                  testele pentru criptare
supabase/migrations/
  0001_schema.sql                tabelele
  0002_cron.sql                  jobul de un minut

dist/water-function.ts           funcția într-un singur fișier, pentru dashboard
tools/                           chei, iconițe, bundle, server local
```

## Comenzi

```bash
npm install        # o singură dată, doar pentru teste
npm test           # verifică criptarea push-ului
npm run bundle     # regenerează dist/water-function.ts după modificări
npm run icons      # regenerează iconițele
npm run serve      # servește aplicația local pe http://localhost:4173
npm run keys       # generează chei noi (invalidează abonamentele existente)
```

## Criptarea notificărilor

`push.js` implementează Web Push direct pe Web Crypto, fără dependențe, ca să
ruleze neschimbat și pe Deno și pe Node. Corectitudinea e verificată în două
trepte în `npm test`: întâi decriptăm un mesaj produs de biblioteca de
referință `web-push`, apoi trecem propriul mesaj prin același decriptor.

## Limitări, pe față

- Merge doar pe iOS 16.4+ și doar cu aplicația adăugată pe ecranul principal.
  Dacă e ștearsă de acolo, abonamentul moare și trebuie refăcut.
- iOS nu permite sunet propriu sau alertă insistentă pentru aplicații web;
  insistența vine din repetarea la 5 minute.
- `appToken` din `config.js` ajunge în browser, deci nu e un secret real — doar
  ține trecătorii departe de endpoint. Cheia privată VAPID și `CRON_TOKEN` stau
  doar ca secrete ale funcției, iar fără `CRON_TOKEN` nimeni nu poate declanșa
  trimiterea de notificări.
- Tabelele au RLS activ și zero politici: nimic nu se vede prin API-ul public,
  totul trece prin funcție.
