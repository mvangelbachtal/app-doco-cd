#!/bin/bash
# Doco-CD Docker Compose Helper
set -e

usage() {
    echo "Usage: $0 <app-name> <docker-compose-command...>"
    exit 1
}

[ $# -lt 2 ] && usage

APP_NAME="$1"
shift
COMPOSE_CMD=("$@")

# Get container with this app's label
CONTAINER_ID=$(docker ps --filter "label=com.docker.compose.project=$APP_NAME" -q --no-trunc | head -1)
[ -z "$CONTAINER_ID" ] && { echo "Error: No containers for '$APP_NAME'"; exit 1; }

# Extract artifact root from mounts
ARTIFACT_ROOT=$(docker inspect "$CONTAINER_ID" --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{end}}{{end}}' 2>/dev/null | \
    tr '|' '\n' | grep -E 'artifacts/[a-f0-9]{40}' | \
    sed -E 's|^(.*/artifacts/[a-f0-9]{40})(/.*)?$|\1|' | head -1)

# Search for compose file
WORKING_DIR=""
if [ -n "$ARTIFACT_ROOT" ] && [ -f "$ARTIFACT_ROOT/compose.yml" ]; then
    WORKING_DIR="$ARTIFACT_ROOT"
elif [ -n "$ARTIFACT_ROOT" ] && [ -f "$ARTIFACT_ROOT/docker-compose.yml" ]; then
    WORKING_DIR="$ARTIFACT_ROOT"
else
    # Fallback: search volume
    DOCO_VOLUME=$(docker volume inspect doco-cd_data --format '{{.Mountpoint}}' 2>/dev/null || echo "/var/lib/docker/volumes/doco-cd_data/_data")
    WORKING_DIR=$(find "$DOCO_VOLUME" -maxdepth 4 -type f \( -name "docker-compose.yml" -o -name "compose.yml" \) 2>/dev/null | head -1 | xargs dirname)
fi

[ -z "$WORKING_DIR" ] || [ ! -d "$WORKING_DIR" ] && { echo "Error: Could not locate working directory"; exit 1; }

cd "$WORKING_DIR"

# Build docker compose command with project name and secrets
CMD=(docker compose --project-name "$APP_NAME")
[ -f "/opt/doco-cd/secrets.env" ] && CMD+=(--env-file "/opt/doco-cd/secrets.env")
CMD+=("${COMPOSE_CMD[@]}")

echo "[doco-helper] App: $APP_NAME"
echo "[doco-helper] Working directory: $WORKING_DIR"
echo ""

"${CMD[@]}"