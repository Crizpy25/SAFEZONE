-- Run in Supabase SQL Editor. These RPCs keep admin call mutations atomic
-- and bypass browser-side RLS filtering after validating the admin session.

create or replace function public.end_emergency_call(
    p_alert_id bigint,
    p_admin_id bigint,
    p_admin_peer_id text
)
returns setof public.emergency_alerts
language sql
security definer
set search_path = public
as $$
    update public.emergency_alerts as alert
       set status = 'ended'
     where alert.id = p_alert_id
       and alert.status not in ('ended', 'cancelled', 'failed', 'completed')
       and alert.answered_by_admin_id = p_admin_id
       and alert.answered_by_peer_id = p_admin_peer_id
    returning alert.*;
$$;

revoke all on function public.end_emergency_call(bigint, bigint, text) from public;
grant execute on function public.end_emergency_call(bigint, bigint, text) to anon, authenticated;

notify pgrst, 'reload schema';
