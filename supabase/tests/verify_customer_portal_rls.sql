begin;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='subscription_proposals' and policyname='proposals_read_own') then
    raise exception 'missing proposal ownership policy';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='payments' and policyname='payments_read_own') then
    raise exception 'missing payment ownership policy';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='assessment_attachments' and policyname='attachments_read_own') then
    raise exception 'missing attachment ownership policy';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema='public' and table_name in ('audit_logs','notification_outbox')
      and grantee in ('anon','authenticated')
  ) then
    raise exception 'sensitive operational tables are exposed';
  end if;
end $$;

rollback;
