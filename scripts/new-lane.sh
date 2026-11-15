#!/usr/bin/env bash
set -euo pipefail

# scripts/new-lane.sh <name> [--remove]
#
# Creates (or, with --remove, tears down) a parallel dev lane: its own git
# worktree + branch off main, its own .env with per-lane ports/origins/DB
# overridden, and its own pair of databases in the single shared Docker
# Compose Postgres instance.
#
# Port slots are fixed per lane name, hardcoded below (no registry file).
# Add a case to add a new lane letter.
usage() {
  echo "Usage: $(basename "$0") <name> [--remove]" >&2
  echo "Known lane names: b, c" >&2
  exit 1
}

[ "$#" -ge 1 ] || usage

NAME="$1"
MODE="create"
if [ "${2:-}" = "--remove" ]; then
  MODE="remove"
elif [ -n "${2:-}" ]; then
  usage
fi

case "$NAME" in
  b) BACKEND_PORT=3010; VITE_PORT=5183 ;;
  c) BACKEND_PORT=3020; VITE_PORT=5193 ;;
  *)
    echo "Unknown lane name '${NAME}'." >&2
    usage
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKTREE_DIR="$(cd "$REPO_ROOT/.." && pwd)/second-income-coach-${NAME}"
BRANCH="lane/${NAME}"
CONTAINER="second-income-coach-postgres"
DB_NAME="second_income_coach_${NAME}"
TEST_DB_NAME="${DB_NAME}_test"

require_container_running() {
  if ! docker ps --filter "name=^/${CONTAINER}\$" --filter "status=running" --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    echo "Postgres container '${CONTAINER}' isn't running. Start it with 'npm run db:up' first." >&2
    exit 1
  fi
}

pg_user() {
  docker exec "$CONTAINER" printenv POSTGRES_USER
}

db_exec() {
  docker exec "$CONTAINER" psql -U "$(pg_user)" -d postgres -v ON_ERROR_STOP=1 "$@"
}

create_db_if_missing() {
  local db="$1" exists
  exists="$(db_exec -tAc "SELECT 1 FROM pg_database WHERE datname = '${db}'")"
  if [ "$exists" = "1" ]; then
    echo "  - database ${db} already exists, skipping"
  else
    db_exec -c "CREATE DATABASE \"${db}\";"
    echo "  - created database ${db}"
  fi
}

drop_db() {
  local db="$1"
  db_exec -c "DROP DATABASE IF EXISTS \"${db}\" WITH (FORCE);"
  echo "  - dropped database ${db} (if it existed)"
}

get_env_var() {
  local file="$1" key="$2"
  grep "^${key}=" "$file" | head -n1 | cut -d'=' -f2-
}

set_env_var() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$file"
}

if [ "$MODE" = "remove" ]; then
  echo "Removing lane '${NAME}'..."
  require_container_running
  if git -C "$REPO_ROOT" worktree list --porcelain | grep -qx "worktree ${WORKTREE_DIR}"; then
    git -C "$REPO_ROOT" worktree remove --force "$WORKTREE_DIR"
    echo "  - removed worktree ${WORKTREE_DIR}"
  elif [ -d "$WORKTREE_DIR" ]; then
    echo "  - ${WORKTREE_DIR} exists but isn't a registered git worktree; leaving it for manual inspection" >&2
  else
    echo "  - no worktree at ${WORKTREE_DIR}, skipping"
  fi
  drop_db "$DB_NAME"
  drop_db "$TEST_DB_NAME"
  echo "Branch ${BRANCH} was kept. Lane '${NAME}' removed."
  exit 0
fi

# --- create mode ---

if [ -e "$WORKTREE_DIR" ]; then
  echo "Worktree directory already exists: ${WORKTREE_DIR}" >&2
  echo "Run '$(basename "$0") ${NAME} --remove' first if you want to recreate it." >&2
  exit 1
fi

if [ ! -f "$REPO_ROOT/.env" ]; then
  echo "No .env at ${REPO_ROOT}/.env to copy from. Create one (see .env.example) first." >&2
  exit 1
fi

require_container_running

echo "Creating lane '${NAME}' (backend :${BACKEND_PORT}, vite :${VITE_PORT})..."

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
  echo "  - branch ${BRANCH} already exists, reusing it"
  git -C "$REPO_ROOT" worktree add "$WORKTREE_DIR" "$BRANCH"
else
  git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE_DIR" main
fi
echo "  - worktree ready at ${WORKTREE_DIR}"

ENV_FILE="${WORKTREE_DIR}/.env"
cp "$REPO_ROOT/.env" "$ENV_FILE"

set_env_var "$ENV_FILE" PORT "$BACKEND_PORT"
set_env_var "$ENV_FILE" WEB_PORT "$VITE_PORT"
# Keeps this lane's Vite dev proxy pointed at this lane's own backend instead
# of the default :3000 (web/vite.config.ts's WEB_PORT/API_PROXY_TARGET pair).
set_env_var "$ENV_FILE" API_PROXY_TARGET "http://localhost:${BACKEND_PORT}"
set_env_var "$ENV_FILE" CORS_ORIGIN "http://localhost:${VITE_PORT}"
# Must be the Vite origin, not the backend's: the browser only ever talks to
# Vite's /api proxy (see .env.example / src/api/middleware/session.ts).
set_env_var "$ENV_FILE" GOOGLE_REDIRECT_URI "http://localhost:${VITE_PORT}/api/auth/google/callback"

RAW_DB_URL="$(get_env_var "$ENV_FILE" DATABASE_URL)"
DB_URL_BASE="${RAW_DB_URL%/*}"
set_env_var "$ENV_FILE" DATABASE_URL "${DB_URL_BASE}/${DB_NAME}"

BASE_LANGSMITH_PROJECT="$(get_env_var "$ENV_FILE" LANGSMITH_PROJECT)"
set_env_var "$ENV_FILE" LANGSMITH_PROJECT "${BASE_LANGSMITH_PROJECT:-second-income-coach}-lane-${NAME}"

echo "  - wrote lane overrides to ${ENV_FILE}"

echo "  - running npm ci (this can take a while)..."
( cd "$WORKTREE_DIR" && npm ci )

echo "  - provisioning databases on ${CONTAINER}..."
create_db_if_missing "$DB_NAME"
create_db_if_missing "$TEST_DB_NAME"

echo "  - applying migrations..."
( cd "$WORKTREE_DIR" && npm run db:migrate --workspace=src )
( cd "$WORKTREE_DIR" && DATABASE_URL="${DB_URL_BASE}/${TEST_DB_NAME}" npm run db:migrate --workspace=src )

cat <<EOF

Lane '${NAME}' is ready:
  worktree:  ${WORKTREE_DIR}
  branch:    ${BRANCH}
  backend:   http://localhost:${BACKEND_PORT}
  vite:      http://localhost:${VITE_PORT}
  databases: ${DB_NAME}, ${TEST_DB_NAME}

Start it with:
  cd ${WORKTREE_DIR} && npm run dev
EOF
