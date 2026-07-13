#!/usr/bin/env bash
set -euo pipefail

project_dir="/srv/dartahara/supabase"
base_url="http://127.0.0.1:56321"
response_file="$(mktemp)"
trap 'rm -f "${response_file}"' EXIT

secret_key="$(sed -n 's/^SUPABASE_SECRET_KEY=//p' "${project_dir}/.env")"
if [[ -z "${secret_key}" ]]; then
  echo "SUPABASE_SECRET_KEY is missing" >&2
  exit 1
fi

status="$(curl --silent --show-error --output "${response_file}" --write-out '%{http_code}' \
  --header "apikey: ${secret_key}" \
  "${base_url}/rest/v1/home_assessments?select=id&limit=1")"

test "${status}" = "200"
test "$(tr -d '[:space:]' < "${response_file}")" = "[]"

table_count="$(docker exec dar-tahara-supabase-db psql -U postgres -d postgres -Atc \
  "select count(*) from pg_tables where schemaname = 'public' and tablename in ('customers','properties','staff_members','home_assessments','subscriptions','invoices','assessment_events','customer_messages','stripe_webhook_events')")"
test "${table_count}" = "9"

echo "service_rest_ok"
echo "schema_tables_ok"
