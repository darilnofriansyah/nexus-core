import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { RenderWorkerConfig } from "./worker-config";

export interface RenderWorkspace {
  root: string;
  shotsDir: string;
  normalizedDir: string;
  audioPath: string;
  captionVttPath: string;
  captionSrtPath: string;
  concatListPath: string;
  concatenatedVideoPath: string;
  finalOutputPath: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STALE_MS = 24 * 60 * 60 * 1000;

export class TempWorkspaceService {
  private readonly tempDir: string;

  constructor(config: Pick<RenderWorkerConfig, "tempDir">) {
    this.tempDir = resolve(config.tempDir);
  }

  async create(jobId: string): Promise<RenderWorkspace> {
    this.assertJobId(jobId);
    await this.ensureTempDir();
    const root = join(this.tempDir, jobId);
    await rm(root, { recursive: true, force: true });
    const shotsDir = join(root, "shots");
    const normalizedDir = join(root, "normalized");
    await mkdir(shotsDir, { recursive: true });
    await mkdir(normalizedDir);
    return {
      root,
      shotsDir,
      normalizedDir,
      audioPath: join(root, "audio.source"),
      captionVttPath: join(root, "captions.vtt"),
      captionSrtPath: join(root, "captions.srt"),
      concatListPath: join(root, "concat.txt"),
      concatenatedVideoPath: join(root, "video-concat.mp4"),
      finalOutputPath: join(root, "master.mp4"),
    };
  }

  async remove(workspace: RenderWorkspace): Promise<void> {
    await this.ensureTempDir();
    const root = resolve(workspace.root);
    if (root === this.tempDir || dirname(root) !== this.tempDir || !UUID_PATTERN.test(root.slice(this.tempDir.length + 1))) {
      throw new Error("Invalid render workspace path");
    }
    await rm(root, { recursive: true, force: true });
  }

  async cleanupStale(now = new Date()): Promise<number> {
    await this.ensureTempDir();
    const cutoff = now.getTime() - STALE_MS;
    let removed = 0;
    for (const entry of await readdir(this.tempDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !UUID_PATTERN.test(entry.name)) continue;
      const path = join(this.tempDir, entry.name);
      const stats = await lstat(path);
      if (stats.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  private assertJobId(jobId: string): void {
    if (!UUID_PATTERN.test(jobId)) throw new Error("jobId must be a valid UUID");
  }

  private async ensureTempDir(): Promise<void> {
    await mkdir(this.tempDir, { recursive: true });
    const stats = await lstat(this.tempDir);
    if (!stats.isDirectory() || stats.isSymbolicLink() || (await realpath(this.tempDir)) !== this.tempDir) {
      throw new Error("Invalid render worker temporary directory");
    }
  }
}
