#!/usr/bin/env bash
# build-and-push.sh — build the recorder image and push it to Docker Hub.
#
# Usage:
#   ./build-and-push.sh            # tags <version> from package.json + latest
#   ./build-and-push.sh 1.2.3      # explicit version tag (+ latest)
#
# Also creates a local git tag for the version after a successful push
# (never pushes it; never overwrites an existing tag).
#
# Requires: docker, node (to read package.json). Login must already exist
# (docker login -u pdebiss) — the script checks and tells you if not.
set -euo pipefail

IMAGE="pdebiss/discord-meeting-recorder"
cd "$(dirname "$0")"

# Read "version" from package.json as the default tag.
VERSION="${1:-$(node -p "require('./package.json').version")}"

echo "==> Build context: $(pwd)"
echo "==> Image: ${IMAGE}  tags: ${VERSION}, latest"

docker compose build

docker tag "discord-meeting-recorder:latest" "${IMAGE}:${VERSION}"
docker tag "discord-meeting-recorder:latest" "${IMAGE}:latest"

echo "==> Pushing ${IMAGE}:${VERSION}"
docker push "${IMAGE}:${VERSION}"

echo "==> Pushing ${IMAGE}:latest"
docker push "${IMAGE}:latest"

# Tag the current branch HEAD with the version for image <-> commit traceability.
if git rev-parse -q --verify "refs/tags/${VERSION}" >/dev/null 2>&1; then
  echo "==> Git tag ${VERSION} already exists — leaving it alone (no overwrite)."
else
  git tag "${VERSION}"
  echo "==> Tagged HEAD ($(git rev-parse --short HEAD)) as ${VERSION}"
fi
echo "    Push the tag to the remote when ready:  git push origin ${VERSION}"

# Show the pushed digest so the server deploy can pin it if desired.
DIGEST=$(docker inspect --format '{{index .RepoDigests 0}}' "${IMAGE}:latest" 2>/dev/null || true)
echo
echo "==> Done."
[ -n "${DIGEST}" ] && echo "    ${DIGEST}"
echo
echo "Deploy on the remote box:"
echo "    docker compose pull && docker compose up -d"
