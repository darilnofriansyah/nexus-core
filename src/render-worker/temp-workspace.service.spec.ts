import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { TempWorkspaceService } from "./temp-workspace.service";

async function temporaryRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "render-workspace-test-"));
}

test("creates a confined workspace with generated render paths", async () => {
  const root = await temporaryRoot();
  try {
    const service = new TempWorkspaceService({ tempDir: root });
    const jobId = randomUUID();
    const workspace = await service.create(jobId);

    assert.equal(workspace.root, join(root, jobId));
    assert.equal(workspace.shotsDir, join(root, jobId, "shots"));
    assert.equal(workspace.normalizedDir, join(root, jobId, "normalized"));
    assert.equal(workspace.audioPath, join(root, jobId, "audio.source"));
    assert.equal(workspace.captionVttPath, join(root, jobId, "captions.vtt"));
    assert.equal(workspace.captionSrtPath, join(root, jobId, "captions.srt"));
    assert.equal(workspace.concatListPath, join(root, jobId, "concat.txt"));
    assert.equal(workspace.concatenatedVideoPath, join(root, jobId, "video-concat.mp4"));
    assert.equal(workspace.finalOutputPath, join(root, jobId, "master.mp4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-UUID job IDs before creating paths", async () => {
  const root = await temporaryRoot();
  try {
    const service = new TempWorkspaceService({ tempDir: root });
    await assert.rejects(service.create("../../escape"), /valid UUID/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes an existing exact job directory before recreation", async () => {
  const root = await temporaryRoot();
  try {
    const jobId = randomUUID();
    const jobRoot = join(root, jobId);
    await mkdir(jobRoot, { recursive: true });
    await writeFile(join(jobRoot, "stale.txt"), "stale");
    const service = new TempWorkspaceService({ tempDir: root });
    const workspace = await service.create(jobId);

    await assert.rejects(readFile(join(workspace.root, "stale.txt")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleans stale direct-child job directories but preserves root and recent jobs", async () => {
  const root = await temporaryRoot();
  try {
    const staleId = randomUUID();
    const recentId = randomUUID();
    const stale = join(root, staleId);
    const recent = join(root, recentId);
    await mkdir(stale);
    await mkdir(recent);
    const now = new Date("2026-08-29T12:00:00.000Z");
    const old = new Date(now.getTime() - 25 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await utimes(recent, new Date(now.getTime() - 60 * 60 * 1000), new Date(now.getTime() - 60 * 60 * 1000));

    const removed = await new TempWorkspaceService({ tempDir: root }).cleanupStale(now);

    assert.equal(removed, 1);
    await assert.rejects(readFile(stale));
    await access(recent);
    await access(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skips symlink directories during stale cleanup", async () => {
  const root = await temporaryRoot();
  const target = await temporaryRoot();
  try {
    const link = join(root, randomUUID());
    await symlink(target, link, "dir");
    const old = new Date("2026-08-28T00:00:00.000Z");
    await utimes(link, old, old);

    assert.equal(await new TempWorkspaceService({ tempDir: root }).cleanupStale(new Date("2026-08-29T12:00:00.000Z")), 0);
    await access(target);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("rejects a configured symlink temp root", async () => {
  const root = await temporaryRoot();
  const target = await temporaryRoot();
  const link = `${root}-link`;
  try {
    await rm(root, { recursive: true, force: true });
    await symlink(target, link, "dir");
    await assert.rejects(new TempWorkspaceService({ tempDir: link }).create(randomUUID()), /temporary directory/i);
    await access(target);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(link, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("rechecks the canonical root before stale cleanup", async () => {
  const root = await temporaryRoot();
  const target = await temporaryRoot();
  try {
    const service = new TempWorkspaceService({ tempDir: root });
    await service.create(randomUUID());
    await rm(root, { recursive: true, force: true });
    await symlink(target, root, "dir");
    await assert.rejects(service.cleanupStale(), /temporary directory/i);
    await access(target);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test("removes a workspace recursively without removing the temp root", async () => {
  const root = await temporaryRoot();
  try {
    const service = new TempWorkspaceService({ tempDir: root });
    const workspace = await service.create(randomUUID());
    await writeFile(join(workspace.shotsDir, "shot-0001.source"), "source");
    await service.remove(workspace);
    await assert.rejects(readFile(workspace.root));
    await access(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
