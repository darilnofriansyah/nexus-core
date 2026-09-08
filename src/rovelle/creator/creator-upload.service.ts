import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { AssetService } from "../assets/asset.service";
import { CanonService } from "../canon/canon.service";
import { CreatorRepository } from "./creator.repository";

const SAFE_UNAVAILABLE = "This upload link is unavailable. Return to Telegram and start again.";
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const CREATOR_UPLOAD_BASE_URL = "rovelle.creatorUploadBaseUrl";

@Injectable()
export class CreatorUploadService {
  constructor(
    private readonly repository: CreatorRepository,
    private readonly assets: AssetService,
    private readonly canon: CanonService,
    @Inject(CREATOR_UPLOAD_BASE_URL) private readonly publicBaseUrl?: string,
  ) {}

  pageUrl(token: string): string {
    if (!this.publicBaseUrl?.startsWith("https://")) throw new Error("Creator upload page is not configured");
    return new URL(`/api/rovelle/creator/uploads/${token}`, this.publicBaseUrl).toString();
  }

  async page(token: string): Promise<string> {
    const { action } = await this.pending(token);
    return mobilePage(action.kind === "UPLOAD_CANON" ? "image/*" : "audio/*");
  }

  async prepare(token: string, body: unknown) {
    const { action } = await this.pending(token);
    const file = readFile(body, action.kind);
    const payload = readUploadPayload(action.kind, action.payload);
    if (!payload) throw new BadRequestException(SAFE_UNAVAILABLE);

    if (payload.assetId) {
      if (payload.mediaType !== file.mediaType) throw new BadRequestException("Use the same file type for this upload.");
      return { upload: (await this.assets.createUploadUrl(payload.assetId)).upload };
    }

    const claim = await this.repository.claimUploadReservation({
      token,
      telegramUserId: action.telegramUserId,
      assetId: randomUUID(),
      mediaType: file.mediaType,
    });
    if (claim.status === "reserving") throw new BadRequestException("This upload is being prepared. Try again shortly.");
    if (claim.status !== "claimed") throw new NotFoundException(SAFE_UNAVAILABLE);
    const reservation = await this.assets.reserveWithId({
      assetType: payload.assetType,
      mediaType: file.mediaType,
      originalFilename: file.originalFilename,
      episodeId: payload.episodeId,
    }, claim.assetId);
    const updated = await this.repository.bindReservedUploadAsset({
      token,
      telegramUserId: action.telegramUserId,
      payload: { ...(isRecord(action.payload) ? action.payload : {}), assetId: reservation.asset.id, mediaType: file.mediaType },
    });
    if (updated.status !== "pending") throw new NotFoundException(SAFE_UNAVAILABLE);
    return { upload: reservation.upload };
  }

  async complete(token: string): Promise<{ text: string }> {
    const claim = await this.repository.claimUploadCompletion({ token, telegramUserId: "976684739" });
    if (claim.status === "duplicate") return safeResult(claim.result) ?? { text: "This upload was already completed. Return to Telegram." };
    if (claim.status === "processing") return { text: "This upload is being completed. Return to Telegram shortly." };
    if (claim.status !== "claimed") throw new NotFoundException(SAFE_UNAVAILABLE);
    const session = await this.repository.findSession(claim.action.telegramUserId);
    const payload = readUploadPayload(claim.action.kind, claim.action.payload);
    if (!session || !payload?.assetId) throw new BadRequestException(SAFE_UNAVAILABLE);

    const asset = await this.assets.confirmUpload(payload.assetId);
    const result = claim.action.kind === "UPLOAD_CANON"
      ? await this.attachCanon(claim.action.telegramUserId, session, payload, asset.id)
      : await this.storeAudio(claim.action.telegramUserId, session, payload, asset.id);
    const completed = await this.finalize({
      token,
      telegramUserId: claim.action.telegramUserId,
      result,
    });
    return completed.status === "duplicate"
      ? safeResult(completed.result) ?? { text: "This upload was already completed. Return to Telegram." }
      : result;
  }

  private async pending(token: string) {
    const state = await this.repository.findPendingUploadActionByToken(token);
    if (state.status !== "pending") throw new NotFoundException(SAFE_UNAVAILABLE);
    if (!(await this.repository.findSession(state.action.telegramUserId))) throw new NotFoundException(SAFE_UNAVAILABLE);
    return state;
  }

  private async finalize(input: { token: string; telegramUserId: string; result: { text: string } }) {
    try {
      return await this.repository.completeUploadAction(input);
    } catch {
      return this.repository.completeUploadAction(input);
    }
  }

  private async attachCanon(
    telegramUserId: string,
    session: { step: string; data: unknown },
    payload: UploadPayload,
    assetId: string,
  ): Promise<{ text: string }> {
    if (!payload.canonVersionId) throw new BadRequestException(SAFE_UNAVAILABLE);
    try {
      await this.canon.attachAsset(payload.canonVersionId, { assetId, role: "REFERENCE" });
    } catch {
      const version = await this.canon.getVersion(payload.canonVersionId);
      if (!version.assets.some((attachment) => attachment.asset.id === assetId)) throw new BadRequestException(SAFE_UNAVAILABLE);
    }
    const data = isRecord(session.data) ? session.data : {};
    await this.repository.upsertSession({
      telegramUserId,
      step: session.step,
      data: { ...data, pendingCanonLockVersionId: payload.canonVersionId },
    });
    return { text: "Canon image attached. Return to Telegram to review and lock it." };
  }

  private async storeAudio(
    telegramUserId: string,
    session: { step: string; data: unknown },
    payload: UploadPayload,
    assetId: string,
  ): Promise<{ text: string }> {
    const data = isRecord(session.data) ? session.data : {};
    if (!payload.episodeId || data.episodeId !== payload.episodeId) throw new BadRequestException(SAFE_UNAVAILABLE);
    await this.repository.upsertSession({ telegramUserId, step: session.step, data: { ...data, audioMasterAssetId: assetId } });
    return { text: "Audio master is ready. Return to Telegram to render the episode." };
  }
}

type UploadPayload = {
  assetType: "CHARACTER_REFERENCE" | "ENVIRONMENT_REFERENCE" | "STYLE_REFERENCE" | "AUDIO_MASTER";
  canonVersionId?: string;
  episodeId?: string;
  assetId?: string;
  mediaType?: string;
};

function readUploadPayload(kind: string, value: unknown): UploadPayload | null {
  if (!isRecord(value)) return null;
  const assetId = typeof value.assetId === "string" && ASSET_ID.test(value.assetId) ? value.assetId : undefined;
  const mediaType = typeof value.mediaType === "string" ? value.mediaType : undefined;
  if (kind === "UPLOAD_CANON" && typeof value.canonVersionId === "string" && ["CHARACTER_REFERENCE", "ENVIRONMENT_REFERENCE", "STYLE_REFERENCE"].includes(String(value.assetType))) {
    return { assetType: value.assetType as UploadPayload["assetType"], canonVersionId: value.canonVersionId, assetId, mediaType };
  }
  if (kind === "UPLOAD_AUDIO" && typeof value.episodeId === "string") {
    return { assetType: "AUDIO_MASTER", episodeId: value.episodeId, assetId, mediaType };
  }
  return null;
}

function readFile(value: unknown, kind: string): { mediaType: string; originalFilename?: string } {
  if (!isRecord(value) || typeof value.mediaType !== "string") throw new BadRequestException("Choose a file before uploading.");
  const mediaType = value.mediaType.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) throw new BadRequestException("Choose a valid file type.");
  if (kind === "UPLOAD_CANON" && !mediaType.startsWith("image/")) throw new BadRequestException("Canon uploads must be images.");
  if (kind === "UPLOAD_AUDIO" && !mediaType.startsWith("audio/")) throw new BadRequestException("Audio master uploads must be audio files.");
  const originalFilename = typeof value.originalFilename === "string" ? value.originalFilename.trim().slice(0, 255) || undefined : undefined;
  return { mediaType, originalFilename };
}

function safeResult(value: unknown): { text: string } | null {
  return isRecord(value) && typeof value.text === "string" ? { text: value.text } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mobilePage(accept: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rovelle upload</title><input id="file" type="file" accept="${accept}"><button id="upload" type="button">Upload</button><p id="status" aria-live="polite"></p><script>const f=document.querySelector('#file'),b=document.querySelector('#upload'),s=document.querySelector('#status'),p=location.pathname.replace(/\/$/,'');b.onclick=async()=>{const x=f.files[0];if(!x){s.textContent='Choose a file first.';return}b.disabled=true;try{const a=await fetch(p+'/prepare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mediaType:x.type,originalFilename:x.name})});const j=await a.json();if(!a.ok)throw Error();const u=j.data.upload;const put=await fetch(u.url,{method:u.method,headers:u.headers,body:x});if(!put.ok)throw Error();const c=await fetch(p+'/complete',{method:'POST'}),r=await c.json();if(!c.ok)throw Error();s.textContent=r.data.text}catch(_){s.textContent='Upload failed. Return to Telegram and try again.'}finally{b.disabled=false}};</script>`;
}
