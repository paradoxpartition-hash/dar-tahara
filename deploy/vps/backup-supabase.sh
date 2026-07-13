#!/usr/bin/env bash
set -euo pipefail

project_dir="/srv/dartahara/supabase"
backup_dir="/srv/dartahara/backups"
retention_days="14"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="${backup_dir}/dar-tahara-${timestamp}.dump"

install -d -m 0700 "${backup_dir}"

postgres_password="$(sed -n 's/^POSTGRES_PASSWORD=//p' "${project_dir}/.env")"
if [[ -z "${postgres_password}" ]]; then
  echo "POSTGRES_PASSWORD is missing from ${project_dir}/.env" >&2
  exit 1
fi

docker exec \
  --env "PGPASSWORD=${postgres_password}" \
  dar-tahara-supabase-db \
  pg_dump --username postgres --dbname postgres --format custom --no-owner --no-privileges \
  > "${destination}"

chmod 0600 "${destination}"
find "${backup_dir}" -type f -name 'dar-tahara-*.dump' -mtime "+${retention_days}" -delete

docker exec -i dar-tahara-supabase-db pg_restore --list < "${destination}" >/dev/null
