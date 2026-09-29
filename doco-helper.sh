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

# Compose records its project directory on containers, including apps that use
# named volumes instead of bind mounts.
WORKING_DIR=$(docker inspect "$CONTAINER_ID" --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' 2>/dev/null || true)

# Extract artifact root from mounts when the Compose label is unavailable.
ARTIFACT_ROOT=$(docker inspect "$CONTAINER_ID" --format '{{range .Mounts}}{{if eq .Type "bind"}}{{.Source}}|{{end}}{{end}}' 2>/dev/null | \
    tr '|' '\n' | grep -E 'artifacts/[a-f0-9]{40}' | \
    sed -E 's|^(.*/artifacts/[a-f0-9]{40})(/.*)?$|\1|' | head -1)

# Search for compose file
if [ -n "$WORKING_DIR" ] && [ ! -f "$WORKING_DIR/compose.yml" ] && [ ! -f "$WORKING_DIR/docker-compose.yml" ]; then
    WORKING_DIR=""
fi

if [ -z "$WORKING_DIR" ] && [ -n "$ARTIFACT_ROOT" ] && [ -f "$ARTIFACT_ROOT/compose.yml" ]; then
    WORKING_DIR="$ARTIFACT_ROOT"
elif [ -z "$WORKING_DIR" ] && [ -n "$ARTIFACT_ROOT" ] && [ -f "$ARTIFACT_ROOT/docker-compose.yml" ]; then
    WORKING_DIR="$ARTIFACT_ROOT"
fi

if [ -z "$WORKING_DIR" ]; then
    # Fallback: find this app's artifact compose file without assuming mounts.
    DOCO_VOLUME=$(docker volume inspect doco-cd_data --format '{{.Mountpoint}}' 2>/dev/null || echo "/var/lib/docker/volumes/doco-cd_data/_data")
    COMPOSE_FILE=$(find "$DOCO_VOLUME" -type f -path "*/app-$APP_NAME/artifacts/*/compose.yml" -print -quit 2>/dev/null || true)
    if [ -n "$COMPOSE_FILE" ]; then
        WORKING_DIR=$(dirname "$COMPOSE_FILE")
    fi
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