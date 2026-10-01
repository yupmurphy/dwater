# Setup dwater — de la zero la notificări pe iPhone

Durează 20–30 de minute. Valorile cerute mai jos sunt deja generate în
`SECRETE.local.md` (fișier local, nu ajunge pe GitHub).

---

## 1. Proiect Supabase nou

1. Intră pe [database.new](https://database.new) și creează un proiect, de
   exemplu `dwater`.
2. Regiune: **Frankfurt (eu-central-1)** — cea mai apropiată de Moldova.
3. Notează-ți parola bazei de date undeva.
4. Din URL-ul dashboardului (`.../project/XXXXXXXX`) copiază `XXXXXXXX`.
   Ăsta e **project ref**-ul, îți trebuie de trei ori mai jos.

## 2. Tabelele

**SQL Editor** → **New query** → lipește tot conținutul din
`supabase/migrations/0001_schema.sql` → **Run**.

Trebuie să apară patru tabele în Table Editor: `water_settings`, `water_state`,
`water_subscriptions`, `water_log`.

## 3. Secretele funcției

**Project Settings** → **Edge Functions** → **Secrets** → adaugă cele cinci
valori din `SECRETE.local.md`:

| Nume | De unde |
| --- | --- |
| `VAPID_PUBLIC_KEY` | din `SECRETE.local.md` |
| `VAPID_PRIVATE_KEY` | din `SECRETE.local.md` |
| `VAPID_SUBJECT` | `mailto:` + adresa ta de email |
| `APP_TOKEN` | din `SECRETE.local.md` |
| `CRON_TOKEN` | din `SECRETE.local.md` |

`VAPID_SUBJECT` e adresa de contact pe care o vede serverul de push al Apple
dacă ceva nu merge. Pune o adresă reală a ta; nu e afișată soției în aplicație.

## 4. Funcția edge `water`

### Varianta A — din dashboard, fără să instalezi nimic

1. **Edge Functions** → **Create a new function**, nume exact: `water`.
2. Șterge codul propus și lipește tot conținutul din
   **`dist/water-function.ts`** (e aceeași funcție, cu `push.js` deja inclus).
3. **Deploy**.
4. În setările funcției, oprește **Verify JWT**. Fără asta aplicația primește
   401, pentru că nu folosim conturi Supabase.

### Varianta B — din terminal, cu CLI

```bash
npx supabase login
npx supabase link --project-ref PROJECT_REF
npx supabase functions deploy water --no-verify-jwt
```

CLI-ul citește `supabase/config.toml`, unde `verify_jwt = false` e deja setat.

## 5. Cronul care trimite notificările

Deschide `supabase/migrations/0002_cron.sql` și înlocuiește:

- `PROJECT_REF` → ref-ul proiectului
- `CRON_TOKEN` → valoarea din `SECRETE.local.md`

Apoi rulează-l în **SQL Editor**.

Verifică după un minut:

```sql
select jobname, schedule, active from cron.job;
select status_code, content from net._http_response order by created desc limit 5;
```

`status_code` trebuie să fie `200`. Dacă e `401`, `CRON_TOKEN` din SQL nu
coincide cu secretul funcției.

## 6. Configurează aplicația

În `config.js`, înlocuiește `PUNE_AICI_REF_UL` cu ref-ul proiectului:

```js
projectRef: "abcdefghijklmnop",
```

## 7. Publică pe GitHub Pages

```bash
git remote add origin https://github.com/yupmurphy/dwater.git
git push -u origin main
```

Apoi în repo: **Settings** → **Pages** → **Source: Deploy from a branch** →
branch `main`, folder `/ (root)` → **Save**.

După un minut aplicația e la:
**https://yupmurphy.github.io/dwater/**

## 8. Pe iPhone-ul soției

1. Deschide linkul **în Safari** (nu Chrome, nu dintr-un mesaj deschis în altă aplicație).
2. Butonul **Share** (pătratul cu săgeata) → **Add to Home Screen**.
3. Închide Safari și deschide **dwater** de pe ecranul principal.
4. Apasă **Pornește notificările** → **Allow**.
5. Deschide **Setări și diagnostic** → **Trimite o notificare de test**.

Dacă notificarea de test ajunge, totul e gata.

---

## Cum reglezi orarul

Totul se schimbă dintr-un singur rând, fără redeploy. Orele sunt în minute de
la miezul nopții (07:00 = 420, 09:30 = 570, 23:00 = 1380):

```sql
update water_settings set
  slots          = '{420,570,720,870,1020,1170,1320}',  -- orele de reminder
  daily_goal     = 7,     -- pahare pe zi
  repeat_minutes = 5,     -- la cât se repetă dacă nu bifează
  max_repeats    = 8,     -- câte reluări maxim per slot
  quiet_start    = 1380,  -- 23:00
  quiet_end      = 420,   -- 07:00
  grace_minutes  = 20,    -- un pahar băut cu 20 min înainte acoperă slotul
  timezone       = 'Europe/Chisinau'
where id = 1;
```

Modificarea se aplică la următorul minut.

## Dacă nu vin notificări

| Simptom | De verificat |
| --- | --- |
| „Dispozitive abonate: 0" în diagnostic | Deschide aplicația de pe ecranul principal și apasă din nou pe pornire |
| Notificarea de test nu ajunge | iPhone: **Setări → Notificări → dwater → Allow Notifications** |
| Nimic nu se întâmplă la ore | `select * from cron.job_run_details order by start_time desc limit 10;` |
| Erori în funcție | Dashboard → Edge Functions → `water` → **Logs** |
| A șters aplicația de pe ecran | Trebuie reinstalată și repornite notificările — abonamentul vechi moare |

## De știut

- Merge doar pe **iOS 16.4 sau mai nou**, și doar cu aplicația pe ecranul principal.
- Dacă telefonul e în **Focus / Do Not Disturb**, notificările așteaptă acolo.
- Nu putem pune sunet propriu sau alarmă insistentă — iOS nu permite asta
  pentru aplicațiile web. Insistența vine din repetarea la 5 minute.
- Proiectul Supabase pe plan gratuit se suspendă după o săptămână de
  inactivitate; cronul care rulează în fiecare minut îl ține treaz.
- Cronul face ~1440 de apeluri pe zi, mult sub limita gratuită de 500.000 de
  invocări pe lună.
