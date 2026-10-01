-- Wakes the edge function once a minute. The function itself decides whether
-- this particular minute deserves a notification, which keeps all the
-- schedule and quiet-hours logic in one place.
--
-- BEFORE RUNNING: replace CRON_TOKEN below with the value set as the
-- CRON_TOKEN function secret. It stays a placeholder in this file on purpose,
-- because this file is public - the filled-in version to paste into the SQL
-- Editor is in SECRETE.local.md, which git ignores.

create extension if not exists pg_net;
create extension if not exists pg_cron;

-- Re-running this file is safe: drop the old job first if it exists.
select cron.unschedule('water-tick')
where exists (select 1 from cron.job where jobname = 'water-tick');

select cron.schedule(
  'water-tick',
  '* * * * *',
  $job$
  select net.http_post(
    url     := 'https://bhijmycooghocnjjwmdc.supabase.co/functions/v1/water/tick',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-token', 'CRON_TOKEN'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 8000
  );
  $job$
);

-- Useful afterwards:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 10;
--   select status_code, content from net._http_response order by created desc limit 5;
