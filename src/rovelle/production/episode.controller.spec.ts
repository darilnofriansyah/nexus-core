import * as assert from "node:assert/strict";
import { test } from "node:test";
import {
  CreateEpisodeRequestDto,
  ReplaceEpisodeShotsRequestDto,
  UpdateEpisodeBriefRequestDto,
} from "./dto/episode.dto";
import { EpisodeService } from "./episode.service";
import { EpisodeController } from "./episode.controller";

const createRequest: CreateEpisodeRequestDto = {
  code: "EP-001",
  title: "Berry Count",
  targetDurationSeconds: 30,
};
const briefRequest: UpdateEpisodeBriefRequestDto = {
  brief: { premise: "Count berries" },
};
const shotsRequest: ReplaceEpisodeShotsRequestDto = {
  shots: [{ sequence: 1, direction: "Opening" }],
};

function createController() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const data = { id: "episode-1", status: "DRAFT" };
  const service = {
    createEpisode: async (...args: unknown[]) => {
      calls.push({ method: "createEpisode", args });
      return data;
    },
    getEpisode: async (...args: unknown[]) => {
      calls.push({ method: "getEpisode", args });
      return data;
    },
    updateBrief: async (...args: unknown[]) => {
      calls.push({ method: "updateBrief", args });
      return data;
    },
    approveBrief: async (...args: unknown[]) => {
      calls.push({ method: "approveBrief", args });
      return data;
    },
    startPreproduction: async (...args: unknown[]) => {
      calls.push({ method: "startPreproduction", args });
      return data;
    },
    replaceShots: async (...args: unknown[]) => {
      calls.push({ method: "replaceShots", args });
      return data;
    },
    markReadyToGenerate: async (...args: unknown[]) => {
      calls.push({ method: "markReadyToGenerate", args });
      return data;
    },
  };

  return {
    calls,
    data,
    controller: new EpisodeController(service as unknown as EpisodeService),
  };
}

const routeCases = [
  {
    name: "creates an episode",
    method: "createEpisode",
    args: [createRequest],
    call: (controller: EpisodeController) =>
      controller.createEpisode(createRequest),
  },
  {
    name: "gets an episode",
    method: "getEpisode",
    args: ["episode-1"],
    call: (controller: EpisodeController) => controller.getEpisode("episode-1"),
  },
  {
    name: "updates an episode brief",
    method: "updateBrief",
    args: ["episode-1", briefRequest],
    call: (controller: EpisodeController) =>
      controller.updateBrief("episode-1", briefRequest),
  },
  {
    name: "approves an episode brief",
    method: "approveBrief",
    args: ["episode-1"],
    call: (controller: EpisodeController) =>
      controller.approveBrief("episode-1"),
  },
  {
    name: "starts episode preproduction",
    method: "startPreproduction",
    args: ["episode-1"],
    call: (controller: EpisodeController) =>
      controller.startPreproduction("episode-1"),
  },
  {
    name: "replaces episode shots",
    method: "replaceShots",
    args: ["episode-1", shotsRequest],
    call: (controller: EpisodeController) =>
      controller.replaceShots("episode-1", shotsRequest),
  },
  {
    name: "marks an episode ready to generate",
    method: "markReadyToGenerate",
    args: ["episode-1"],
    call: (controller: EpisodeController) =>
      controller.markReadyToGenerate("episode-1"),
  },
] as const;

for (const routeCase of routeCases) {
  test(routeCase.name, async () => {
    const { calls, data, controller } = createController();

    const result = await routeCase.call(controller);

    assert.deepEqual(result, { ok: true, data });
    assert.deepEqual(calls, [
      { method: routeCase.method, args: routeCase.args },
    ]);
  });
}
