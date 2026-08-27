import * as assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaService } from "../../database/prisma.service";
import {
  RovelleEpisode,
  RovelleEpisodeStatus,
  RovelleShot,
  RovelleShotStatus,
} from "../../generated/prisma/client";
import type { CreateEpisodeRequestDto } from "./dto/episode.dto";
import { EpisodeRepository, EpisodeWithShots } from "./episode.repository";

type RepositoryCall = {
  operation: string;
  args: unknown;
  inTransaction: boolean;
};

type FakeOptions = {
  createdEpisode?: EpisodeWithShots;
  foundEpisodes?: Array<RovelleEpisode | null>;
  updatedCounts?: number[];
  transactionEpisode?: RovelleEpisode | null;
  transactionShotCount?: number;
};

const episode: RovelleEpisode = {
  id: "episode-1",
  code: "EP-001",
  title: "Berry Count",
  status: RovelleEpisodeStatus.DRAFT,
  brief: null,
  targetDurationSeconds: 60,
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:00:00.000Z"),
};

const shot: RovelleShot = {
  id: "shot-1",
  episodeId: episode.id,
  sequence: 1,
  name: "Opening",
  direction: "Open on the basket.",
  targetDurationSeconds: 10,
  status: RovelleShotStatus.DRAFT,
  createdAt: new Date("2026-08-27T00:00:00.000Z"),
  updatedAt: new Date("2026-08-27T00:00:00.000Z"),
};

const aggregate: EpisodeWithShots = { ...episode, shots: [shot] };

function createRepository(options: FakeOptions = {}) {
  const calls: RepositoryCall[] = [];
  const foundEpisodes = [...(options.foundEpisodes ?? [episode])];
  const updatedCounts = [...(options.updatedCounts ?? [1])];
  const transactionEpisode =
    options.transactionEpisode === undefined
      ? episode
      : options.transactionEpisode;
  const transactionShotCount = options.transactionShotCount ?? 1;
  let inTransaction = false;
  let transactionCount = 0;

  const record = (operation: string, args: unknown) => {
    calls.push({ operation, args, inTransaction });
  };
  const next = <T>(values: T[], fallback: T): T => values.shift() ?? fallback;

  const transactionClient = {
    rovelleEpisode: {
      findUnique: async (args: unknown) => {
        record("episode.findUnique", args);
        return transactionEpisode;
      },
      updateMany: async (args: unknown) => {
        record("episode.updateMany", args);
        return { count: next(updatedCounts, 1) };
      },
    },
    rovelleShot: {
      count: async (args: unknown) => {
        record("shot.count", args);
        return transactionShotCount;
      },
      deleteMany: async (args: unknown) => {
        record("shot.deleteMany", args);
        return { count: 1 };
      },
      createMany: async (args: unknown) => {
        record("shot.createMany", args);
        return { count: 1 };
      },
      updateMany: async (args: unknown) => {
        record("shot.updateMany", args);
        return { count: 1 };
      },
    },
  };

  const client = {
    ...transactionClient,
    rovelleEpisode: {
      ...transactionClient.rovelleEpisode,
      create: async (args: unknown) => {
        record("episode.create", args);
        return options.createdEpisode ?? aggregate;
      },
      findUnique: async (args: unknown) => {
        record("episode.findUnique", args);
        return next(foundEpisodes, null);
      },
    },
    $transaction: async <T>(
      callback: (transaction: typeof transactionClient) => Promise<T>,
    ): Promise<T> => {
      transactionCount += 1;
      inTransaction = true;
      try {
        return await callback(transactionClient);
      } finally {
        inTransaction = false;
      }
    },
  };

  const prisma = { client } as unknown as PrismaService;
  return {
    calls,
    repository: new EpisodeRepository(prisma),
    get transactionCount() {
      return transactionCount;
    },
  };
}

function callsFor(
  calls: RepositoryCall[],
  operation: string,
): RepositoryCall[] {
  return calls.filter((call) => call.operation === operation);
}

test("createEpisode maps the episode fields and includes ordered shots", async () => {
  const { calls, repository } = createRepository();
  const request: CreateEpisodeRequestDto = {
    code: "EP-001",
    title: "Berry Count",
    targetDurationSeconds: 60,
  };

  await repository.createEpisode(request);

  assert.deepEqual(calls[0], {
    operation: "episode.create",
    args: {
      data: {
        code: "EP-001",
        title: "Berry Count",
        targetDurationSeconds: 60,
      },
      include: { shots: { orderBy: { sequence: "asc" } } },
    },
    inTransaction: false,
  });
});

test("findEpisode includes shots ordered by sequence", async () => {
  const { calls, repository } = createRepository();

  await repository.findEpisode("episode-1");

  assert.deepEqual(calls[0], {
    operation: "episode.findUnique",
    args: {
      where: { id: "episode-1" },
      include: { shots: { orderBy: { sequence: "asc" } } },
    },
    inTransaction: false,
  });
});

test("updateBrief only updates a draft episode and reloads its aggregate", async () => {
  const { calls, repository } = createRepository({
    foundEpisodes: [aggregate],
  });
  const brief = { premise: "Count berries" };

  const result = await repository.updateBrief("episode-1", brief);

  assert.deepEqual(result, aggregate);
  assert.deepEqual(callsFor(calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: { id: "episode-1", status: RovelleEpisodeStatus.DRAFT },
      data: { brief },
    },
    inTransaction: false,
  });
  assert.equal(callsFor(calls, "episode.findUnique").length, 1);
});

test("updateBrief returns null when the conditional draft update misses", async () => {
  const { calls, repository } = createRepository({ updatedCounts: [0] });

  const result = await repository.updateBrief("episode-1", { premise: "x" });

  assert.equal(result, null);
  assert.equal(callsFor(calls, "episode.findUnique").length, 0);
});

test("transitionStatus conditionally updates the expected status and reloads", async () => {
  const { calls, repository } = createRepository({
    foundEpisodes: [aggregate],
  });

  const result = await repository.transitionStatus(
    "episode-1",
    RovelleEpisodeStatus.DRAFT,
    RovelleEpisodeStatus.BRIEF_APPROVED,
  );

  assert.deepEqual(result, aggregate);
  assert.deepEqual(callsFor(calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: { id: "episode-1", status: RovelleEpisodeStatus.DRAFT },
      data: { status: RovelleEpisodeStatus.BRIEF_APPROVED },
    },
    inTransaction: false,
  });
});

test("transitionStatus returns null when the conditional update misses", async () => {
  const { calls, repository } = createRepository({ updatedCounts: [0] });

  const result = await repository.transitionStatus(
    "episode-1",
    RovelleEpisodeStatus.DRAFT,
    RovelleEpisodeStatus.BRIEF_APPROVED,
  );

  assert.equal(result, null);
  assert.equal(callsFor(calls, "episode.findUnique").length, 0);
});

test("replaceShots deletes old shots and creates replacements in one transaction", async () => {
  const fake = createRepository({
    transactionEpisode: {
      ...episode,
      status: RovelleEpisodeStatus.PREPRODUCTION,
    },
    foundEpisodes: [aggregate],
  });
  const replacements = [
    {
      sequence: 2,
      name: null,
      direction: "Close on the basket.",
      targetDurationSeconds: undefined,
    },
  ];

  const result = await fake.repository.replaceShots("episode-1", replacements);

  assert.deepEqual(result, aggregate);
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "shot.deleteMany")[0], {
    operation: "shot.deleteMany",
    args: { where: { episodeId: "episode-1" } },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "shot.createMany")[0], {
    operation: "shot.createMany",
    args: {
      data: [
        {
          episodeId: "episode-1",
          sequence: 2,
          name: null,
          direction: "Close on the basket.",
          targetDurationSeconds: null,
        },
      ],
    },
    inTransaction: true,
  });
});

test("replaceShots returns null and leaves shots untouched outside preproduction", async () => {
  const { calls, repository } = createRepository({
    transactionEpisode: { ...episode, status: RovelleEpisodeStatus.DRAFT },
  });

  const result = await repository.replaceShots("episode-1", []);

  assert.equal(result, null);
  assert.equal(callsFor(calls, "shot.deleteMany").length, 0);
  assert.equal(callsFor(calls, "shot.createMany").length, 0);
});

test("replaceShots returns null without deleting when the preproduction guard misses", async () => {
  const fake = createRepository({
    transactionEpisode: {
      ...episode,
      status: RovelleEpisodeStatus.PREPRODUCTION,
    },
    updatedCounts: [0],
  });

  const result = await fake.repository.replaceShots("episode-1", [
    { sequence: 1, direction: "Open on the basket." },
  ]);

  assert.equal(result, null);
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: {
        id: "episode-1",
        status: RovelleEpisodeStatus.PREPRODUCTION,
      },
      data: { status: RovelleEpisodeStatus.PREPRODUCTION },
    },
    inTransaction: true,
  });
  assert.equal(callsFor(fake.calls, "shot.deleteMany").length, 0);
  assert.equal(callsFor(fake.calls, "shot.createMany").length, 0);
});

test("replaceShots omits createMany when replacing with no shots", async () => {
  const { calls, repository } = createRepository({
    transactionEpisode: {
      ...episode,
      status: RovelleEpisodeStatus.PREPRODUCTION,
    },
    foundEpisodes: [aggregate],
  });

  await repository.replaceShots("episode-1", []);

  assert.equal(callsFor(calls, "shot.deleteMany").length, 1);
  assert.equal(callsFor(calls, "shot.createMany").length, 0);
});

test("markReady reports a missing episode from its transaction", async () => {
  const fake = createRepository({
    transactionEpisode: null,
  });

  const result = await fake.repository.markReady("episode-1");

  assert.deepEqual(result, { status: "not_found" });
  assert.equal(fake.transactionCount, 1);
  assert.equal(callsFor(fake.calls, "shot.count").length, 0);
});

test("markReady rejects an episode outside preproduction", async () => {
  const { calls, repository } = createRepository({
    transactionEpisode: { ...episode, status: RovelleEpisodeStatus.DRAFT },
  });

  const result = await repository.markReady("episode-1");

  assert.deepEqual(result, { status: "invalid_state" });
  assert.equal(callsFor(calls, "shot.count").length, 0);
});

test("markReady rejects preproduction episodes with no shots", async () => {
  const { calls, repository } = createRepository({
    transactionEpisode: {
      ...episode,
      status: RovelleEpisodeStatus.PREPRODUCTION,
    },
    transactionShotCount: 0,
  });

  const result = await repository.markReady("episode-1");

  assert.deepEqual(result, { status: "no_shots" });
  assert.deepEqual(callsFor(calls, "shot.count")[0], {
    operation: "shot.count",
    args: { where: { episodeId: "episode-1" } },
    inTransaction: true,
  });
  assert.equal(callsFor(calls, "shot.updateMany").length, 0);
});

test("markReady updates every shot and the episode atomically", async () => {
  const readyEpisode = {
    ...episode,
    status: RovelleEpisodeStatus.READY_TO_GENERATE,
  };
  const readyAggregate = {
    ...readyEpisode,
    shots: [{ ...shot, status: RovelleShotStatus.READY_TO_GENERATE }],
  };
  const fake = createRepository({
    transactionEpisode: {
      ...episode,
      status: RovelleEpisodeStatus.PREPRODUCTION,
    },
    foundEpisodes: [readyAggregate],
  });

  const result = await fake.repository.markReady("episode-1");

  assert.deepEqual(result, { status: "ready", episode: readyAggregate });
  assert.equal(fake.transactionCount, 1);
  assert.deepEqual(callsFor(fake.calls, "shot.updateMany")[0], {
    operation: "shot.updateMany",
    args: {
      where: { episodeId: "episode-1" },
      data: { status: RovelleShotStatus.READY_TO_GENERATE },
    },
    inTransaction: true,
  });
  assert.deepEqual(callsFor(fake.calls, "episode.updateMany")[0], {
    operation: "episode.updateMany",
    args: {
      where: {
        id: "episode-1",
        status: RovelleEpisodeStatus.PREPRODUCTION,
      },
      data: { status: RovelleEpisodeStatus.READY_TO_GENERATE },
    },
    inTransaction: true,
  });
});

test("markReady reports invalid_state when the conditional episode update misses", async () => {
  const { calls, repository } = createRepository({
    transactionEpisode: {
      ...episode,
      status: RovelleEpisodeStatus.PREPRODUCTION,
    },
    updatedCounts: [0],
  });

  const result = await repository.markReady("episode-1");

  assert.deepEqual(result, { status: "invalid_state" });
  assert.equal(callsFor(calls, "shot.updateMany").length, 1);
  assert.equal(callsFor(calls, "episode.findUnique").length, 1);
});
