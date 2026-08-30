import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

import type { RenderWorkerConfig } from "./worker-config";
import { RenderWorkerError } from "./media-transfer.service";

export interface NormalizeShotInput {
  sourcePath: string;
  outputPath: string;
  durationSeconds: number;
}

export interface FinalMuxInput {
  concatenatedVideoPath: string;
  audioPath: string;
  captionPath: string | null;
  captionFormat: "WEBVTT" | "SRT" | null;
  durationSeconds: number;
  outputPath: string;
}

export interface FfmpegChildProcess {
  stderr: NodeJS.ReadableStream | null;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface FfmpegSpawnOptions {
  shell: false;
  stdio: ["ignore", "ignore", "pipe"];
}

export type FfmpegSpawn = (
  command: string,
  args: string[],
  options: FfmpegSpawnOptions,
) => FfmpegChildProcess;

const MAX_STDERR_BYTES = 16 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 4000;
const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s"'<>]+/gi;

const defaultSpawn: FfmpegSpawn = (command, args, options) =>
  spawn(command, args, options);

export class FfmpegRunner {
  private readonly ffmpegPath: string;
  private readonly spawnProcess: FfmpegSpawn;
  private activeProcess: FfmpegChildProcess | null = null;
  private terminateActive: (() => void) | null = null;

  constructor(
    config: Pick<RenderWorkerConfig, "ffmpegPath">,
    spawnProcess?: FfmpegSpawn,
  );
  constructor(ffmpegPath: string, spawnProcess?: FfmpegSpawn);
  constructor(
    configOrPath: Pick<RenderWorkerConfig, "ffmpegPath"> | string,
    spawnProcess: FfmpegSpawn = defaultSpawn,
  ) {
    this.ffmpegPath =
      typeof configOrPath === "string" ? configOrPath : configOrPath.ffmpegPath;
    this.spawnProcess = spawnProcess;
  }

  async verifyBinary(): Promise<void> {
    await this.run(["-hide_banner", "-version"]);
  }

  async normalizeShot(
    input: NormalizeShotInput,
    signal: AbortSignal,
  ): Promise<void> {
    const duration = decimalDuration(input.durationSeconds);
    await this.run(
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        input.sourcePath,
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        `scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${duration},setpts=PTS-STARTPTS,format=yuv420p`,
        "-t",
        duration,
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-threads",
        "1",
        "-map_metadata",
        "-1",
        input.outputPath,
      ],
      signal,
    );
  }

  async concatenate(
    inputPaths: string[],
    listPath: string,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (inputPaths.length === 0) {
      throw new RenderWorkerError(
        "FFMPEG_FAILED",
        "At least one normalized shot is required",
      );
    }

    let listContents: string;
    try {
      listContents = `${inputPaths.map(concatLine).join("\n")}\n`;
    } catch {
      throw new RenderWorkerError(
        "FFMPEG_FAILED",
        "Normalized shot path is invalid",
      );
    }

    try {
      await writeFile(listPath, listContents, "utf8");
    } catch {
      throw new RenderWorkerError(
        "FFMPEG_FAILED",
        "FFmpeg concat list could not be written",
      );
    }

    await this.run(
      [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        listPath,
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-fflags",
        "+genpts",
        "-map_metadata",
        "-1",
        outputPath,
      ],
      signal,
    );
  }

  async muxFinal(input: FinalMuxInput, signal: AbortSignal): Promise<void> {
    const duration = decimalDuration(input.durationSeconds);
    const hasCaption = input.captionPath !== null;
    if (
      hasCaption !== (input.captionFormat !== null) ||
      (hasCaption &&
        input.captionFormat !== "WEBVTT" &&
        input.captionFormat !== "SRT")
    ) {
      throw new RenderWorkerError(
        "FFMPEG_FAILED",
        "Caption path and format must be provided together",
      );
    }

    const args = [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      input.concatenatedVideoPath,
      "-i",
      input.audioPath,
    ];
    if (hasCaption) args.push("-i", input.captionPath as string);
    args.push("-map", "0:v:0", "-map", "1:a:0");
    if (hasCaption) {
      args.push(
        "-map",
        "2:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-af",
        "apad",
        "-c:s",
        "mov_text",
        "-metadata:s:s:0",
        "title=Captions",
      );
    } else {
      args.push(
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-ar",
        "48000",
        "-af",
        "apad",
      );
    }
    args.push(
      "-t",
      duration,
      "-threads",
      "1",
      "-movflags",
      "+faststart",
      "-map_metadata",
      "-1",
      "-metadata",
      "creation_time=",
      input.outputPath,
    );

    await this.run(args, signal);
  }

  terminateActiveProcess(): void {
    this.terminateActive?.();
  }

  private run(args: string[], signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new RenderWorkerError("WORKER_SHUTDOWN", "FFmpeg was aborted"),
      );
    }
    if (this.activeProcess) {
      return Promise.reject(
        new RenderWorkerError(
          "FFMPEG_FAILED",
          "Another FFmpeg process is already active",
        ),
      );
    }

    let child: FfmpegChildProcess;
    try {
      child = this.spawnProcess(this.ffmpegPath, args, {
        shell: false,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      return Promise.reject(
        new RenderWorkerError("FFMPEG_FAILED", "FFmpeg failed"),
      );
    }

    this.activeProcess = child;
    return new Promise<void>((resolve, reject) => {
      let stderrTail = Buffer.alloc(0);
      let terminated = false;
      let settled = false;

      const appendStderr = (chunk: unknown): void => {
        const bytes = Buffer.isBuffer(chunk)
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk)
            : Buffer.from(String(chunk));
        if (bytes.byteLength >= MAX_STDERR_BYTES) {
          stderrTail = Buffer.from(bytes.subarray(-MAX_STDERR_BYTES));
          return;
        }
        const combined = Buffer.concat([stderrTail, bytes]);
        stderrTail =
          combined.byteLength > MAX_STDERR_BYTES
            ? Buffer.from(combined.subarray(-MAX_STDERR_BYTES))
            : combined;
      };
      const finish = (error?: RenderWorkerError): void => {
        if (settled) return;
        settled = true;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (this.activeProcess === child) this.activeProcess = null;
        if (this.terminateActive === terminate) this.terminateActive = null;
        if (error) reject(error);
        else resolve();
      };
      const terminate = (): void => {
        if (terminated || settled) return;
        terminated = true;
        child.kill("SIGTERM");
      };
      const onAbort = (): void => terminate();

      this.terminateActive = terminate;
      child.stderr?.on("data", appendStderr);
      child.once("error", () => {
        finish(
          terminated
            ? new RenderWorkerError("WORKER_SHUTDOWN", "FFmpeg was aborted")
            : ffmpegFailure(stderrTail),
        );
      });
      child.once("close", (code) => {
        finish(
          terminated
            ? new RenderWorkerError("WORKER_SHUTDOWN", "FFmpeg was aborted")
            : code === 0
              ? undefined
              : ffmpegFailure(stderrTail),
        );
      });
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
  }
}

export { FfmpegRunner as FFmpegRunner };

function decimalDuration(value: number): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new RenderWorkerError(
      "FFMPEG_FAILED",
      "Duration must be a positive integer",
    );
  }
  return value.toString(10);
}

function concatLine(path: string): string {
  if (/\r|\n/.test(path)) throw new Error("path contains a line break");
  return `file '${path.replaceAll("'", "'\\''")}'`;
}

function ffmpegFailure(stderrTail: Buffer): RenderWorkerError {
  const detail = sanitizeStderr(stderrTail);
  return new RenderWorkerError("FFMPEG_FAILED", detail || "FFmpeg failed");
}

function sanitizeStderr(stderrTail: Buffer): string {
  return stderrTail
    .toString("utf8")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[^\x20-\x7e]+/g, " ")
    .replace(URL_PATTERN, "[redacted-url]")
    .slice(-MAX_ERROR_MESSAGE_LENGTH)
    .trim();
}
