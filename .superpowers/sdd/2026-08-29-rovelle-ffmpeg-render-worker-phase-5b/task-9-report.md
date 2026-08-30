# Task 9 report

## Status

Implemented the dedicated FFmpeg render-worker image and Compose service.

## Changes

- Added `Dockerfile.render-worker` with a Node 22 Alpine build stage and a separate production stage.
- Installed `ca-certificates` and `ffmpeg` only in the production stage; this provides `/usr/bin/ffmpeg` and `/usr/bin/ffprobe`.
- Kept the worker image free of an exposed or published port.
- Created `/tmp/rovelle-render-worker`, changed `/app` and the worker directory to `node:node`, and run the worker as `node`.
- Added the `render-worker` Compose service with the requested production environment, external `veyra-network`, `unless-stopped` restart policy, and five-minute stop grace period.
- Did not add Redis, an n8n dependency, Docker socket mounts, or port publication.
- Left the existing `core-api` image and port behavior unchanged.

## Validation

- `docker compose config --no-interpolate` passed and expanded both `core-api` and `render-worker`; the worker has no `ports` or `expose`, uses `veyra-network`, and has no `depends_on` or `volumes` entries.
- `git diff --check` passed.
- Docker image builds and binary checks were not run because the repository policy forbids local builds, and the worker Dockerfile build stage invokes `npm run build`.
- A regular `docker compose config` attempt was blocked by the worktree's existing missing `../.env` file; the no-interpolate validation still verified the static Compose structure.

## Commit

`build(rovelle): add ffmpeg render worker service`
