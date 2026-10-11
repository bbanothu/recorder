# syntax=docker/dockerfile:1

# ---- build stage: install production deps (incl. native @snazzah/davey) ----
FROM node:22-bookworm-slim AS build

WORKDIR /app

# package-lock.json is present -> reproducible, prod-only install
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- runtime stage ----
FROM node:22-bookworm-slim

# ffmpeg is needed for the master mix (every session builds one) — WAV -> libopus;
# the app falls back to plain .wav if it is missing, so keep it for full fidelity.
# python3 + venv host the faster-whisper transcription sidecar (scripts/transcribe.py).
# tini (via --init in compose) + ca-certs for Discord WSS/CDN.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*

# Isolated venv so faster-whisper never touches the system python (node user
# only reads/execs it; root-owned is fine). Runs BEFORE `USER node`.
# av pinned: faster-whisper 1.2.1 calls av.open(..., metadata_errors=...), a
# kwarg PyAV 15+ dropped — `pip install faster-whisper` with no pin grabs
# whatever av is newest and breaks every transcription with
# "TypeError: open() got an unexpected keyword argument 'metadata_errors'".
RUN python3 -m venv /opt/venv \
 && /opt/venv/bin/pip install --no-cache-dir faster-whisper==1.2.1 "av<15"

# Create the recordings mount point owned by "node" BEFORE USER node and the
# VOLUME instruction: Docker copies the image's mount-point ownership into a
# fresh named volume, so the non-root app can write recordings.
RUN mkdir -p /data && chown node:node /data

# Run as the built-in non-root "node" user
USER node

WORKDIR /app

COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
# The transcription sidecar resolves at ../scripts/transcribe.py relative to
# src/ — without this COPY, transcription is dead on arrival in the image.
COPY --chown=node:node scripts ./scripts

# MEETINGS_DIR is set by docker-compose to /data (a named/volume mount).
VOLUME /data

# /opt/venv/bin first on PATH: defaultPythonBin() resolves `python3` to the venv
# interpreter, which has faster-whisper installed (system python stays pristine).
# HF_HOME on the recordings volume: the Whisper model cache persists across
# redeploys; the first stop downloads ~460 MB for `small`, later ones are instant.
ENV NODE_ENV=production \
    MEETINGS_DIR=/data \
    PATH=/opt/venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    HF_HOME=/data/.cache

CMD ["node", "src/index.js"]
