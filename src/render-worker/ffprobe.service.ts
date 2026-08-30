import { spawn } from "node:child_process";

import { Injectable } from "@nestjs/common";

import type { RenderWorkerConfig } from "./worker-config";
import { RenderWorkerError } from "./media-transfer.service";

export interface ProbedVideo {
  codec: string;
  width: number;
  height: number;
  pixelFormat: string | null;
  frameRate: number;
  durationSeconds: number;
}

export interface ProbedAudio {
  codec: string;
  sampleRate: number;
}

export interface ProbedMaster {
  video: ProbedVideo;
  audio: ProbedAudio;
  subtitleCodec: string | null;
  durationSeconds: number;
}

export interface FfprobeChildProcess {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface FfprobeSpawnOptions {
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

export type FfprobeSpawn = (
  command: string,
  args: string[],
  options: FfprobeSpawnOptions,
) => FfprobeChildProcess;

const MAX_STDERR_BYTES = 16 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_MESSAGE_LENGTH = 4000;
const FRAME_RATE_TOLERANCE = 0.01;
const DURATION_TOLERANCE_SECONDS = 0.2;
const URL_PATTERN = /\b(?:https?|ftp):\/\/[^\s"'<>]+/gi;

const defaultSpawn: FfprobeSpawn = (command, args, options) =>
  spawn(command, args, options);

@Injectable()
export class FfprobeService {
  private readonly ffprobePath: string;
  private readonly spawnProcess: FfprobeSpawn;
  private activeProcess: FfprobeChildProcess | null = null;

  constructor(
    config: Pick<RenderWorkerConfig, "ffprobePath">,
    spawnProcess?: FfprobeSpawn,
  );
  constructor(ffprobePath: string, spawnProcess?: FfprobeSpawn);
  constructor(
    configOrPath: Pick<RenderWorkerConfig, "ffprobePath"> | string,
    spawnProcess: FfprobeSpawn = defaultSpawn,
  ) {
    this.ffprobePath =
      typeof configOrPath === "string"
        ? configOrPath
        : configOrPath.ffprobePath;
    this.spawnProcess = spawnProcess;
  }

  async verifyBinary(): Promise<void> {
    await this.run(["-hide_banner", "-version"]);
  }

  async probeVideo(path: string, signal: AbortSignal): Promise<ProbedVideo> {
    const probe = parseProbeJson(await this.run(this.probeArgs(path), signal));
    const video = findStream(probe.streams, "video");
    if (!video) throw invalidMedia("A video stream is required");

    const width = positiveInteger(video.width);
    const height = positiveInteger(video.height);
    const durationSeconds = positiveDuration(video, probe.format);
    if (width === null || height === null || durationSeconds === null) {
      throw invalidMedia("Video dimensions and duration must be positive");
    }

    return {
      codec: requiredString(video.codec_name, "Video codec is missing"),
      width,
      height,
      pixelFormat: optionalString(video.pix_fmt),
      frameRate: readFrameRate(video),
      durationSeconds,
    };
  }

  async verifyMaster(
    input: {
      path: string;
      expectedDurationSeconds: number;
      captionsExpected: boolean;
    },
    signal: AbortSignal,
  ): Promise<ProbedMaster> {
    const probe = parseProbeJson(await this.run(this.probeArgs(input.path), signal));
    if (!isMp4Container(probe.format)) {
      throw invalidMedia("Final media must use an MP4 container");
    }
    const video = findStream(probe.streams, "video");
    const audio = findStream(
      probe.streams,
      "audio",
      (stream) =>
        optionalString(stream.codec_name) === "aac" &&
        positiveInteger(stream.sample_rate) === 48000,
    );
    if (!video || !audio) {
      throw invalidMedia("A video and audio stream are required");
    }

    const parsedVideo = parseVideo(video, probe.format);
    const parsedAudio = parseAudio(audio);
    const durationSeconds = parsePositiveNumber(probe.format?.duration);
    if (!parsedVideo || !parsedAudio || durationSeconds === null) {
      throw invalidMedia("Final media streams are invalid");
    }

    if (
      parsedVideo.codec !== "h264" ||
      parsedVideo.width !== 1080 ||
      parsedVideo.height !== 1920 ||
      parsedVideo.pixelFormat !== "yuv420p" ||
      !Number.isFinite(parsedVideo.frameRate) ||
      !isWithin(parsedVideo.frameRate, 30, FRAME_RATE_TOLERANCE) ||
      parsedAudio.codec !== "aac" ||
      parsedAudio.sampleRate !== 48000 ||
      !Number.isFinite(input.expectedDurationSeconds) ||
      input.expectedDurationSeconds <= 0 ||
      durationSeconds <= 0 ||
      !isWithin(
        durationSeconds,
        input.expectedDurationSeconds,
        DURATION_TOLERANCE_SECONDS,
      )
    ) {
      throw invalidMedia("Final media does not match the render contract");
    }

    const subtitleStreams = probe.streams.filter(
      (stream) => stream.codec_type === "subtitle",
    );
    if (
      subtitleStreams.some(
        (stream) => optionalString(stream.codec_name) !== "mov_text",
      )
    ) {
      throw invalidMedia("Only mov_text subtitle streams are supported");
    }
    const subtitle = subtitleStreams[0] ?? null;
    const subtitleCodec = optionalString(subtitle?.codec_name);
    if (input.captionsExpected && subtitleCodec !== "mov_text") {
      throw invalidMedia("A mov_text subtitle stream is required");
    }

    return {
      video: parsedVideo,
      audio: parsedAudio,
      subtitleCodec,
      durationSeconds,
    };
  }

  private probeArgs(path: string): string[] {
    return [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      path,
    ];
  }

  private run(args: string[], signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) {
      return Promise.reject(
        new RenderWorkerError("WORKER_SHUTDOWN", "ffprobe was aborted"),
      );
    }
    if (this.activeProcess) {
      return Promise.reject(
        new RenderWorkerError(
          "FFPROBE_FAILED",
          "Another ffprobe process is already active",
        ),
      );
    }

    let child: FfprobeChildProcess;
    try {
      child = this.spawnProcess(this.ffprobePath, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      return Promise.reject(ffprobeFailure(Buffer.alloc(0)));
    }

    this.activeProcess = child;
    return new Promise<Buffer>((resolve, reject) => {
      let stdout = Buffer.alloc(0);
      let stderrTail = Buffer.alloc(0);
      let stdoutTooLarge = false;
      let terminated = false;
      let settled = false;

      const appendStdout = (chunk: unknown): void => {
        const bytes = toBuffer(chunk);
        if (stdout.byteLength + bytes.byteLength > MAX_STDOUT_BYTES) {
          stdoutTooLarge = true;
          return;
        }
        stdout = Buffer.concat([stdout, bytes]);
      };
      const appendStderr = (chunk: unknown): void => {
        const bytes = toBuffer(chunk);
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
        if (error) reject(error);
        else resolve(stdout);
      };
      const terminate = (): void => {
        if (terminated || settled) return;
        terminated = true;
        child.kill("SIGTERM");
      };
      const onAbort = (): void => terminate();

      child.stdout?.on("data", appendStdout);
      child.stderr?.on("data", appendStderr);
      child.once("error", () => {
        finish(
          terminated
            ? new RenderWorkerError("WORKER_SHUTDOWN", "ffprobe was aborted")
            : ffprobeFailure(stderrTail),
        );
      });
      child.once("close", (code) => {
        finish(
          terminated
            ? new RenderWorkerError("WORKER_SHUTDOWN", "ffprobe was aborted")
            : code === 0 && !stdoutTooLarge
              ? undefined
              : ffprobeFailure(stderrTail),
        );
      });
      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      }
    });
  }
}

export { FfprobeService as FFprobeService };

function parseProbeJson(output: Buffer): ProbeDocument {
  let value: unknown;
  try {
    value = JSON.parse(output.toString("utf8"));
  } catch {
    throw new RenderWorkerError("FFPROBE_FAILED", "ffprobe returned invalid JSON");
  }

  if (!isRecord(value)) {
    throw invalidMedia("ffprobe output is not an object");
  }

  return {
    streams: Array.isArray(value.streams)
      ? value.streams.filter(isRecord)
      : [],
    format: isRecord(value.format) ? value.format : null,
  };
}

function parseVideo(
  stream: ProbeStream,
  format: ProbeRecord | null,
): ProbedVideo | null {
  const width = positiveInteger(stream.width);
  const height = positiveInteger(stream.height);
  const durationSeconds = positiveDuration(stream, format);
  const codec = optionalString(stream.codec_name);
  if (width === null || height === null || durationSeconds === null || codec === null) {
    return null;
  }

  let frameRate: number;
  try {
    frameRate = readFrameRate(stream);
  } catch {
    return null;
  }

  return {
    codec,
    width,
    height,
    pixelFormat: optionalString(stream.pix_fmt),
    frameRate,
    durationSeconds,
  };
}

function parseAudio(stream: ProbeStream): ProbedAudio | null {
  const codec = optionalString(stream.codec_name);
  const sampleRate = positiveInteger(stream.sample_rate);
  if (codec === null || sampleRate === null) return null;
  return { codec, sampleRate };
}

function readFrameRate(stream: ProbeStream): number {
  const values = [stream.avg_frame_rate, stream.r_frame_rate];
  let foundValue = false;
  for (const value of values) {
    if (value === undefined || value === null) continue;
    foundValue = true;
    const parsed = parseRationalFrameRate(value);
    if (parsed !== null && parsed > 0) return parsed;
  }
  if (!foundValue) return 0;
  throw invalidMedia("Frame rate is invalid");
}

export function parseRationalFrameRate(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const numeric = /^\s*\d+(?:\.\d*)?\s*$/.test(value)
    ? Number(value)
    : null;
  if (numeric !== null) {
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
  }

  const match = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*\/\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*$/.exec(
    value,
  );
  if (!match) return null;

  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (
    !Number.isFinite(numerator) ||
    !Number.isFinite(denominator) ||
    numerator <= 0 ||
    denominator <= 0
  ) {
    return null;
  }

  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function findStream(
  streams: ProbeStream[],
  codecType: string,
  predicate: (stream: ProbeStream) => boolean = () => true,
): ProbeStream | null {
  return (
    streams.find(
      (stream) => stream.codec_type === codecType && predicate(stream),
    ) ?? null
  );
}

function isMp4Container(format: ProbeRecord | null): boolean {
  const formatName = optionalString(format?.format_name);
  return formatName?.split(",").some((name) => name.trim() === "mp4") ?? false;
}

function positiveDuration(
  stream: ProbeStream,
  format: ProbeRecord | null,
): number | null {
  return (
    parsePositiveNumber(stream.duration) ??
    parsePositiveNumber(format?.duration)
  );
}

function positiveInteger(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.trim().length === 0)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parsePositiveNumber(value: unknown): number | null {
  if (
    typeof value !== "number" &&
    (typeof value !== "string" || value.trim().length === 0)
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isWithin(actual: number, expected: number, tolerance: number): boolean {
  return (
    Math.abs(actual - expected) <=
    tolerance + Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(expected))
  );
}

function requiredString(value: unknown, message: string): string {
  const result = optionalString(value);
  if (result === null) throw invalidMedia(message);
  return result;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function invalidMedia(message: string): RenderWorkerError {
  return new RenderWorkerError("OUTPUT_MEDIA_INVALID", message);
}

function ffprobeFailure(stderrTail: Buffer): RenderWorkerError {
  const detail = sanitizeStderr(stderrTail);
  return new RenderWorkerError("FFPROBE_FAILED", detail || "ffprobe failed");
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

function toBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  return Buffer.from(String(chunk));
}

type ProbeRecord = Record<string, unknown>;
type ProbeStream = ProbeRecord;
interface ProbeDocument {
  streams: ProbeStream[];
  format: ProbeRecord | null;
}

function isRecord(value: unknown): value is ProbeRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
