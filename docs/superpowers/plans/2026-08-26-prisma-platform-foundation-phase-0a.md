# Prisma Platform Foundation — Phase 0A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Prisma 7 as shared `nexus-core` database infrastructure, baseline the existing PostgreSQL schema, and prove Prisma can coexist safely with the existing raw `pg` layer without changing Veyra/Aegis product behavior.

**Architecture:** Preserve the current NestJS/CommonJS runtime and existing `DatabaseService`. Add Prisma 7.10.0 with the `prisma-client` generator configured for CommonJS output and `@prisma/adapter-pg`, expose it through a shared global `PrismaModule`, and baseline the already-existing PostgreSQL schema without applying destructive migrations. Existing Veyra/Aegis code continues to use raw `pg`; Prisma becomes available for Rovelle and future new features.

**Tech Stack:** NestJS 10.4.x, TypeScript 5.7.x, Node 22, PostgreSQL, `pg`, Prisma ORM 7.10.0, `@prisma/client` 7.10.0, `@prisma/adapter-pg` 7.10.0, Node native test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-rovelle-core-production-system-design-v2-prisma.md`

## Global Constraints

- Repository: `darilnofriansyah/nexus-core`.
- This plan implements **Phase 0A only**. Do not create `src/rovelle/**` product code.
- Terra is the primary implementation orchestrator.
- Luna Max may implement or review isolated tasks only; Terra owns integration decisions and phase verification.
- Preserve all current Veyra and Aegis behavior.
- Preserve the existing `DatabaseService` and its raw `pg` repositories.
- Do not migrate any existing Veyra/Aegis repository to Prisma in this phase.
- PostgreSQL remains the source of truth.
- Pin Prisma CLI, Client, and PostgreSQL adapter to **7.10.0**.
- Keep Node 22 and the repository's current CommonJS TypeScript module strategy.
- Use Prisma's `prisma-client` generator with explicit `moduleFormat = "cjs"`; do not add `"type": "module"` to `package.json`.
- Use `@prisma/adapter-pg`; do not use the legacy Rust-engine `prisma-client-js` setup.
- Generated Prisma Client belongs under `src/generated/prisma/` and is not committed.
- Existing database schema is baselined; do not reset, recreate, truncate, or destructively modify the existing database.
- `prisma migrate reset` is forbidden against any existing Nexus database.
- Do not run `prisma migrate resolve --applied 0_init` against production during this phase. That is a later explicit rollout operation.
- Do not run `prisma migrate deploy` against production during this phase.
- Real database smoke tests must use a disposable PostgreSQL database or explicitly approved non-production database.
- No production n8n workflow changes.
- No deployment.
- Every task ends with tests and a commit/checkpoint.
- Stop the phase if existing Veyra/Aegis tests regress rather than broadening scope to fix unrelated behavior.

---

## File Structure

### New files

- `prisma.config.ts` — Prisma CLI configuration; points Prisma to the schema/migrations and reads `DATABASE_URL`.
- `prisma/schema.prisma` — introspected existing PostgreSQL schema plus Prisma Client generator configuration.
- `prisma/migrations/0_init/migration.sql` — baseline SQL representing the database state before Rovelle.
- `src/database/prisma.module.ts` — shared/global Nest module exporting `PrismaService`.
- `src/database/prisma.service.ts` — optional Prisma Client wrapper using the PostgreSQL driver adapter.
- `src/database/prisma.service.spec.ts` — unit tests for configured/unconfigured Prisma service behavior.
- `src/database/prisma.integration.spec.ts` — opt-in disposable-database coexistence test for Prisma + raw `pg`.
- `.prettierignore` — excludes generated Prisma sources from formatting.
- `docs/migration/prisma-baseline-rollout.md` — documents the one-time future production baseline marker and explicitly marks it as not executed in Phase 0A.

### Modified files

- `package.json` — pinned Prisma dependencies and generation lifecycle scripts.
- `package-lock.json` — dependency lock.
- `.gitignore` — ignores generated Prisma Client.
- `eslint.config.mjs` — excludes generated Prisma sources.
- `src/config/env.ts` — Prisma pool/timeout configuration.
- `.env.example` — documents Prisma-specific pool settings.
- `src/app.module.ts` — imports shared `PrismaModule`.
- `Dockerfile` — should require no structural rewrite; verify existing build runs Prisma generation through npm lifecycle scripts. Modify only if verification proves the existing build cannot include the generated client.

### Files explicitly not rewritten

- `src/database/database.service.ts`
- existing `src/veyra/**` repositories/services
- existing `src/aegis/**`
- existing historical SQL under `docs/migration/**`

---

## Task 1: Pin the Prisma Toolchain Without Converting Nexus to ESM

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `prisma.config.ts`
- Create: `prisma/schema.prisma`
- Modify: `.gitignore`
- Modify: `eslint.config.mjs`
- Create: `.prettierignore`

**Interfaces:**
- Consumes: current `DATABASE_URL` convention from `src/config/env.ts`.
- Produces:
  - `npm run prisma:generate`
  - Prisma schema at `prisma/schema.prisma`
  - generated CommonJS-compatible Client source at `src/generated/prisma/`
  - migration directory at `prisma/migrations/`

### Required configuration

Use these exact Prisma package versions:

```text
prisma                 7.10.0
@prisma/client         7.10.0
@prisma/adapter-pg     7.10.0
```

Keep the existing `pg` dependency unless npm reports an actual incompatible peer requirement.

- [ ] **Step 1: Verify the pre-change baseline**

Run:

```bash
npm test
npm run lint
npm run build
```

Expected:

```text
all commands exit 0
```

Record the current test count in the implementation notes so Terra can compare the final phase run.

- [ ] **Step 2: Verify Prisma generation does not exist yet**

Run:

```bash
npm run prisma:generate
```

Expected:

```text
FAIL because package.json has no "prisma:generate" script
```

Do not treat this expected failure as a repository regression.

- [ ] **Step 3: Install the pinned Prisma dependencies**

Run:

```bash
npm install --save-exact @prisma/client@7.10.0 @prisma/adapter-pg@7.10.0
npm install --save-dev --save-exact prisma@7.10.0
npm install dotenv
```

Then verify:

```bash
npm ls prisma @prisma/client @prisma/adapter-pg pg
```

Expected:

```text
prisma@7.10.0
@prisma/client@7.10.0
@prisma/adapter-pg@7.10.0
pg resolves successfully with no invalid peer dependency
```

If npm reports a peer incompatibility with the existing `pg`, stop this task and let Terra evaluate the smallest compatible `pg` update. Do not use `--force` or `--legacy-peer-deps`.

- [ ] **Step 4: Add Prisma lifecycle scripts**

Modify `package.json` so the scripts include:

```json
{
  "scripts": {
    "build": "nest build",
    "prebuild": "npm run prisma:generate",
    "format": "prettier --write \"src/**/*.ts\"",
    "lint": "eslint \"src/**/*.ts\"",
    "prisma:generate": "prisma generate",
    "prisma:validate": "prisma validate",
    "test": "tsc -p tsconfig.test.json && node --test \"dist-test/src/**/*.spec.js\"",
    "pretest": "npm run prisma:generate",
    "test:ci": "tsc -p tsconfig.test.json && node --test --test-reporter=spec \"dist-test/src/**/*.spec.js\"",
    "pretest:ci": "npm run prisma:generate",
    "start": "nest start",
    "start:dev": "nest start --watch",
    "start:prod": "node dist/main.js"
  }
}
```

Do **not** add:

```json
"type": "module"
```

Do **not** modify `tsconfig.json` module settings in this task.

Reason: Prisma's current `prisma-client` generator supports explicit CommonJS generation; a repository-wide ESM migration is unnecessary for this phase.

- [ ] **Step 5: Create Prisma CLI configuration**

Create `prisma.config.ts`:

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? '',
  },
});
```

The empty-string fallback is deliberate: `prisma generate` and normal TypeScript builds must work in CI/build contexts where a database URL is absent. Database commands such as `db pull` will still fail clearly until `DATABASE_URL` is provided.

- [ ] **Step 6: Create the initial Prisma schema shell**

Create `prisma/schema.prisma`:

```prisma
generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}
```

Do not add Rovelle models in Phase 0A.

- [ ] **Step 7: Ignore generated Prisma source**

Append to `.gitignore`:

```gitignore
src/generated/prisma/
```

Create `.prettierignore`:

```text
src/generated/prisma/
```

Modify `eslint.config.mjs` so the exported configuration starts with an ignore block:

```js
export default [
  {
    ignores: ['src/generated/prisma/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_' },
      ],
    },
  },
];
```

Do not manually edit anything under `src/generated/prisma/`.

- [ ] **Step 8: Generate the empty Prisma Client**

Run:

```bash
npm run prisma:generate
```

Expected:

```text
PASS
Prisma Client generated under src/generated/prisma/
```

Then run:

```bash
git status --short
```

Expected:

```text
src/generated/prisma/ does not appear as an untracked path
```

- [ ] **Step 9: Validate that CommonJS remains intact**

Run:

```bash
node -p "require('./package.json').type ?? 'commonjs'"
node -p "require('./tsconfig.json').compilerOptions.module"
```

Expected:

```text
commonjs
commonjs
```

- [ ] **Step 10: Re-run baseline checks**

Run:

```bash
npm test
npm run lint
npm run build
```

Expected:

```text
all commands exit 0
existing Veyra/Aegis tests remain green
```

- [ ] **Step 11: Commit/checkpoint**

```bash
git add package.json package-lock.json prisma.config.ts prisma/schema.prisma .gitignore .prettierignore eslint.config.mjs
git commit -m "build(database): add Prisma 7 toolchain"
```

---

## Task 2: Introspect and Baseline the Existing PostgreSQL Schema

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/0_init/migration.sql`
- Create: `docs/migration/prisma-baseline-rollout.md`

**Interfaces:**
- Consumes:
  - `DATABASE_URL`
  - Prisma 7.10.0 toolchain from Task 1
  - existing schema truth documented in `docs/veyra-database-schema.md`
  - existing historical migrations under `docs/migration/`
- Produces:
  - Prisma data model matching the existing database
  - baseline migration `0_init`
  - documented production adoption command, **not executed**

### Safety rule

`prisma db pull` is a schema-introspection operation. Run it only against the current approved development/staging database or an explicitly approved read-only production connection.

This task does **not** modify the connected database.

Never run:

```bash
prisma migrate reset
prisma db push
prisma migrate deploy
prisma migrate resolve --applied 0_init
```

against the existing production database in Phase 0A.

- [ ] **Step 1: Confirm a database URL exists before introspection**

Run:

```bash
node -e "if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required for Prisma baseline introspection'); process.exit(1) } console.log('DATABASE_URL is configured')"
```

Expected:

```text
DATABASE_URL is configured
```

If this command fails, stop Task 2. Do not invent a connection string and do not point Prisma at production without explicit authorization.

- [ ] **Step 2: Introspect the existing database**

Run:

```bash
npx prisma db pull
```

Expected:

```text
PASS
prisma/schema.prisma now contains the existing PostgreSQL models
the generator block remains provider="prisma-client"
the generator output remains "../src/generated/prisma"
the generator moduleFormat remains "cjs"
```

Immediately inspect:

```bash
git diff -- prisma/schema.prisma
```

Reject the result and stop if introspection unexpectedly removes the generator configuration.

- [ ] **Step 3: Format and validate the introspected schema**

Run:

```bash
npx prisma format
npm run prisma:validate
```

Expected:

```text
both exit 0
```

- [ ] **Step 4: Cross-check high-risk existing schema facts**

Read:

```text
docs/veyra-database-schema.md
docs/migration/*.sql
```

Verify the Prisma schema contains the production tables that currently matter to Veyra, including at minimum:

```text
telegram_users
transactions
budgets
budget_alerts
merchant_aliases
category_rules
merchant_review_queue
conversation_states
```

Verify names/relations are introspected rather than manually renamed in Phase 0A.

Do not "clean up" legacy naming.

- [ ] **Step 5: Generate the baseline migration**

Run:

```bash
mkdir -p prisma/migrations/0_init

npx prisma migrate diff \
  --from-empty \
  --to-schema prisma/schema.prisma \
  --script \
  --output prisma/migrations/0_init/migration.sql
```

Expected:

```text
prisma/migrations/0_init/migration.sql exists and is non-empty
```

Verify:

```bash
test -s prisma/migrations/0_init/migration.sql
```

Expected:

```text
exit 0
```

- [ ] **Step 6: Review the baseline for destructive operations**

Run:

```bash
grep -nE 'DROP (TABLE|COLUMN|SCHEMA)|TRUNCATE|DELETE FROM' prisma/migrations/0_init/migration.sql || true
```

Expected:

```text
no destructive statements
```

A baseline from empty should primarily create objects.

If destructive statements appear, stop and investigate before committing.

- [ ] **Step 7: Prove Prisma schema matches the introspected database**

Run:

```bash
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-config-datasource \
  --exit-code
```

Expected:

```text
exit 0
no schema difference
```

If the exit code is 2, inspect unsupported/default/index differences before proceeding. Do not silence the drift check.

- [ ] **Step 8: Regenerate the Client from the real schema**

Run:

```bash
npm run prisma:generate
npm run build
```

Expected:

```text
both exit 0
```

- [ ] **Step 9: Document the future one-time production baseline marker**

Create `docs/migration/prisma-baseline-rollout.md` with this exact operational intent:

```markdown
# Prisma Baseline Rollout

`prisma/migrations/0_init/migration.sql` represents the Nexus PostgreSQL
schema that existed before Prisma Migrate became the migration owner for new
features.

## Phase 0A rule

Do not apply `0_init` to the existing production database. Its objects already
exist.

Do not run `prisma migrate reset` against any Nexus production or staging
database containing real data.

## One-time production adoption

Only during an explicitly approved deployment window, after confirming the
checked-out `prisma/schema.prisma` matches production:

```bash
npx prisma migrate diff \
  --from-schema prisma/schema.prisma \
  --to-config-datasource \
  --exit-code

npx prisma migrate resolve --applied 0_init

npx prisma migrate status
```

Expected before `resolve`: schema diff exits 0.

Expected after `resolve`: `0_init` is recorded as applied and Prisma reports no
pending migration.

This command writes Prisma migration metadata only. It must not be executed by
Phase 0A implementation workers against production.
```

- [ ] **Step 10: Run full verification**

```bash
npm test
npm run lint
npm run build
```

Expected:

```text
all exit 0
```

- [ ] **Step 11: Commit/checkpoint**

```bash
git add prisma/schema.prisma prisma/migrations/0_init/migration.sql docs/migration/prisma-baseline-rollout.md
git commit -m "chore(database): baseline existing schema for Prisma"
```

---

## Task 3: Add Shared PrismaService and PrismaModule

**Files:**
- Create: `src/database/prisma.service.ts`
- Create: `src/database/prisma.module.ts`
- Create: `src/database/prisma.service.spec.ts`
- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Modify: `src/app.module.ts`

**Interfaces:**
- Consumes:
  - generated `PrismaClient` from `src/generated/prisma/client`
  - `PrismaPg` from `@prisma/adapter-pg`
  - current `readEnv()` configuration pattern
- Produces:
  - `PrismaService.isConfigured: boolean`
  - `PrismaService.client: PrismaClient`
  - global `PrismaModule`
  - optional runtime Prisma initialization that does not prevent Core from booting when `DATABASE_URL` is absent

### Required runtime behavior

Existing `DatabaseService` remains unchanged.

Prisma gets its own pool because Prisma 7's driver adapter uses `pg`.

Cap the new Prisma pool so adding Prisma does not silently double the repository's maximum PostgreSQL connection pressure.

Use these defaults:

```text
PRISMA_DATABASE_POOL_MAX=5
PRISMA_DATABASE_CONNECTION_TIMEOUT_MS=5000
```

- [ ] **Step 1: Write failing tests for PrismaService**

Create `src/database/prisma.service.spec.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { PrismaService } from './prisma.service';

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalPoolMax = process.env.PRISMA_DATABASE_POOL_MAX;
const originalConnectionTimeout =
  process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS;

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }

  if (originalPoolMax === undefined) {
    delete process.env.PRISMA_DATABASE_POOL_MAX;
  } else {
    process.env.PRISMA_DATABASE_POOL_MAX = originalPoolMax;
  }

  if (originalConnectionTimeout === undefined) {
    delete process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS;
  } else {
    process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS =
      originalConnectionTimeout;
  }
});

describe('PrismaService', () => {
  test('stays unconfigured when DATABASE_URL is absent', async () => {
    delete process.env.DATABASE_URL;

    const service = new PrismaService();

    assert.equal(service.isConfigured, false);
    assert.throws(
      () => service.client,
      /DATABASE_URL is not configured/,
    );

    await service.onModuleDestroy();
  });

  test('constructs a Prisma client when DATABASE_URL is configured', async () => {
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@127.0.0.1:5432/nexus_test';
    process.env.PRISMA_DATABASE_POOL_MAX = '3';
    process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS = '2500';

    const service = new PrismaService();

    assert.equal(service.isConfigured, true);
    assert.ok(service.client);

    await service.onModuleDestroy();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
npm test -- --test-name-pattern="PrismaService"
```

If the repository's npm script does not forward `--test-name-pattern` through the current two-stage TypeScript + Node command, run:

```bash
npm test
```

Expected:

```text
FAIL because ./prisma.service does not exist
```

- [ ] **Step 3: Add Prisma pool configuration**

Modify `src/config/env.ts`.

Extend `CoreApiEnv` with:

```ts
prismaDatabasePoolMax: number;
prismaDatabaseConnectionTimeoutMs: number;
```

Extend `readEnv()` with:

```ts
prismaDatabasePoolMax: Number(
  process.env.PRISMA_DATABASE_POOL_MAX ?? 5,
),
prismaDatabaseConnectionTimeoutMs: Number(
  process.env.PRISMA_DATABASE_CONNECTION_TIMEOUT_MS ?? 5000,
),
```

Keep every existing property unchanged.

Modify `.env.example` by adding after `DATABASE_URL`:

```dotenv
# Prisma uses a separate pg pool while legacy DatabaseService remains active.
PRISMA_DATABASE_POOL_MAX=5
PRISMA_DATABASE_CONNECTION_TIMEOUT_MS=5000
```

- [ ] **Step 4: Implement PrismaService**

Create `src/database/prisma.service.ts`:

```ts
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { readEnv } from '../config/env';
import { PrismaClient } from '../generated/prisma/client';

@Injectable()
export class PrismaService implements OnModuleDestroy {
  private readonly prisma?: PrismaClient;

  constructor() {
    const env = readEnv();

    if (env.databaseUrl) {
      const adapter = new PrismaPg({
        connectionString: env.databaseUrl,
        max: env.prismaDatabasePoolMax,
        connectionTimeoutMillis: env.prismaDatabaseConnectionTimeoutMs,
      });

      this.prisma = new PrismaClient({ adapter });
    }
  }

  get isConfigured(): boolean {
    return Boolean(this.prisma);
  }

  get client(): PrismaClient {
    if (!this.prisma) {
      throw new Error('DATABASE_URL is not configured');
    }

    return this.prisma;
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma?.$disconnect();
  }
}
```

Do not subclass `PrismaClient` in Phase 0A. The wrapper matches the existing optional `DatabaseService` behavior and allows Core to boot without a configured database.

- [ ] **Step 5: Implement shared PrismaModule**

Create `src/database/prisma.module.ts`:

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 6: Register PrismaModule in AppModule**

Modify `src/app.module.ts`.

Add:

```ts
import { PrismaModule } from './database/prisma.module';
```

Change imports to:

```ts
imports: [DatabaseModule, PrismaModule, AegisModule, VeyraModule],
```

Do not alter existing controllers or guards.

- [ ] **Step 7: Run PrismaService tests**

Run:

```bash
npm test
```

Expected:

```text
PrismaService tests pass
all existing tests pass
```

- [ ] **Step 8: Verify Core still boots without DATABASE_URL**

Run:

```bash
env -u DATABASE_URL npm run build
env -u DATABASE_URL node dist/main.js &
CORE_PID=$!
sleep 2
curl -fsS http://127.0.0.1:3001/api/health
kill "$CORE_PID"
wait "$CORE_PID" 2>/dev/null || true
```

Expected response contains:

```json
{
  "success": true
}
```

and health data with status `ok`.

If port 3001 is occupied, Terra may choose another `PORT` for this smoke command, but must not change application defaults merely to satisfy the smoke test.

- [ ] **Step 9: Run complete repository verification**

```bash
npm test
npm run lint
npm run build
```

Expected:

```text
all exit 0
test count is not lower than the baseline recorded in Task 1
```

- [ ] **Step 10: Commit/checkpoint**

```bash
git add src/database/prisma.service.ts src/database/prisma.module.ts src/database/prisma.service.spec.ts src/config/env.ts .env.example src/app.module.ts
git commit -m "feat(database): expose shared Prisma service"
```

---

## Task 4: Prove Prisma and Legacy pg Coexist on a Disposable Database

**Files:**
- Create: `src/database/prisma.integration.spec.ts`

**Interfaces:**
- Consumes:
  - `PrismaService`
  - existing `DatabaseService`
  - `PRISMA_SMOKE_DATABASE_URL`
  - baseline migration `prisma/migrations/0_init/migration.sql`
- Produces:
  - repeatable opt-in coexistence test
  - proof the Phase 0A architecture can support old `pg` and new Prisma in the same Node process

### Safety

This test is skipped unless `PRISMA_SMOKE_DATABASE_URL` is present.

The supplied URL must point to a disposable database.

Do not set `PRISMA_SMOKE_DATABASE_URL` to production.

- [ ] **Step 1: Write the opt-in integration test**

Create `src/database/prisma.integration.spec.ts`:

```ts
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { DatabaseService } from './database.service';
import { PrismaService } from './prisma.service';

const smokeDatabaseUrl = process.env.PRISMA_SMOKE_DATABASE_URL;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe('Prisma and legacy pg coexistence', { skip: !smokeDatabaseUrl }, () => {
  let database: DatabaseService;
  let prisma: PrismaService;

  before(() => {
    process.env.DATABASE_URL = smokeDatabaseUrl;
    database = new DatabaseService();
    prisma = new PrismaService();
  });

  after(async () => {
    await prisma?.onModuleDestroy();
    await database?.onModuleDestroy();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  test('both clients can query the same PostgreSQL database', async () => {
    const pgResult = await database.query<{ value: number }>(
      'SELECT 1::int AS value',
    );
    const prismaResult = await prisma.client.$queryRaw<
      Array<{ value: number }>
    >`SELECT 1::int AS value`;

    assert.equal(pgResult.rows[0]?.value, 1);
    assert.equal(prismaResult[0]?.value, 1);
  });

  test('loading Prisma does not break pg timestamptz parsing', async () => {
    const result = await database.query<{ value: Date }>(
      'SELECT NOW() AS value',
    );

    assert.ok(result.rows[0]?.value instanceof Date);
  });
});
```

The timestamp test protects the exact coexistence risk that matters when two `pg`-based access layers share one process.

- [ ] **Step 2: Verify default test suite skips external database work**

Run without `PRISMA_SMOKE_DATABASE_URL`:

```bash
unset PRISMA_SMOKE_DATABASE_URL
npm test
```

Expected:

```text
all normal tests pass
Prisma/pg coexistence suite is skipped
no external database connection is attempted by that suite
```

- [ ] **Step 3: Start a disposable PostgreSQL database**

Run:

```bash
docker rm -f nexus-prisma-phase0a-postgres 2>/dev/null || true

docker run -d \
  --name nexus-prisma-phase0a-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=nexus_prisma_phase0a \
  -p 55432:5432 \
  postgres:16-alpine
```

Wait until ready:

```bash
until docker exec nexus-prisma-phase0a-postgres pg_isready -U postgres -d nexus_prisma_phase0a; do
  sleep 1
done
```

Expected:

```text
accepting connections
```

Set:

```bash
export PRISMA_SMOKE_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:55432/nexus_prisma_phase0a'
```

- [ ] **Step 4: Prove the baseline migration can build a database from empty**

Run:

```bash
DATABASE_URL="$PRISMA_SMOKE_DATABASE_URL" npx prisma migrate deploy
```

Expected:

```text
0_init applies successfully to the disposable database
```

Then:

```bash
DATABASE_URL="$PRISMA_SMOKE_DATABASE_URL" npx prisma migrate status
```

Expected:

```text
database schema is up to date
```

This is the only `migrate deploy` in Phase 0A, and it is explicitly limited to the disposable database.

- [ ] **Step 5: Run the coexistence tests against the disposable database**

Run:

```bash
PRISMA_SMOKE_DATABASE_URL="$PRISMA_SMOKE_DATABASE_URL" npm test
```

Expected:

```text
Prisma query passes
legacy DatabaseService query passes
legacy pg timestamptz result remains a Date
all existing tests remain green
```

- [ ] **Step 6: Destroy the disposable database**

Run:

```bash
docker rm -f nexus-prisma-phase0a-postgres
unset PRISMA_SMOKE_DATABASE_URL
```

Expected:

```text
container removed
```

- [ ] **Step 7: Commit/checkpoint**

```bash
git add src/database/prisma.integration.spec.ts
git commit -m "test(database): verify Prisma and pg coexistence"
```

---

## Task 5: Verify Docker and CI Build Semantics

**Files:**
- Verify: `Dockerfile`
- Verify: `tsconfig.json`
- Verify: `tsconfig.build.json`
- Verify: `tsconfig.test.json`
- Modify `Dockerfile` only if the exact verification below fails because generated Prisma sources are missing.

**Interfaces:**
- Consumes:
  - package lifecycle scripts from Task 1
  - generated client compilation
- Produces:
  - deployable Node 22 image containing compiled Prisma Client
  - no repository-wide ESM conversion

- [ ] **Step 1: Verify the normal local pipeline**

Run:

```bash
rm -rf dist dist-test src/generated/prisma

npm ci
npm test
npm run lint
npm run build
```

Expected:

```text
pretest regenerates src/generated/prisma
tests pass
lint ignores generated client
prebuild regenerates the client
build passes
```

- [ ] **Step 2: Confirm generated client compiled into dist**

Run:

```bash
test -f dist/generated/prisma/client.js
```

Expected:

```text
exit 0
```

If Prisma 7.10.0 emits a different generated entry filename, inspect `src/generated/prisma/` and `dist/generated/prisma/` and update only this verification assertion. Do not move generated code into `node_modules`.

- [ ] **Step 3: Build the production Docker image**

Run:

```bash
docker build -t nexus-core:prisma-phase0a .
```

Expected:

```text
image builds successfully
the build stage executes npm run build
prebuild executes prisma generate
production image contains dist/generated/prisma
```

- [ ] **Step 4: Boot the Docker image without database configuration**

Run:

```bash
docker rm -f nexus-core-prisma-phase0a 2>/dev/null || true

docker run -d \
  --name nexus-core-prisma-phase0a \
  -e NODE_ENV=production \
  -e PORT=3000 \
  -p 33001:3000 \
  nexus-core:prisma-phase0a
```

Wait:

```bash
for i in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:33001/api/health >/tmp/nexus-prisma-health.json; then
    break
  fi
  sleep 1
done

cat /tmp/nexus-prisma-health.json
```

Expected:

```text
HTTP request succeeds
health status is ok
Core does not require DATABASE_URL merely to boot
```

Clean up:

```bash
docker rm -f nexus-core-prisma-phase0a
rm -f /tmp/nexus-prisma-health.json
```

- [ ] **Step 5: Verify CommonJS was preserved**

Run:

```bash
node -p "require('./package.json').type ?? 'commonjs'"
node -p "require('./tsconfig.json').compilerOptions.module"
```

Expected:

```text
commonjs
commonjs
```

Inspect the diff:

```bash
git diff -- package.json tsconfig.json tsconfig.build.json tsconfig.test.json
```

Expected:

```text
no repository-wide ESM migration
tsconfig module strategy is unchanged
```

- [ ] **Step 6: Run final Phase 0A verification**

Run:

```bash
npm ci
npm test
npm run lint
npm run build
git status --short
```

Expected:

```text
all commands exit 0
no generated Prisma source is tracked
no unexpected runtime files are modified
```

- [ ] **Step 7: Review the entire Phase 0A diff**

Run:

```bash
git diff main...HEAD --stat
git diff main...HEAD
```

Terra must verify all of these invariants before declaring the phase complete:

```text
[ ] no src/rovelle product code exists
[ ] no Veyra repository was converted to Prisma
[ ] no Aegis behavior changed
[ ] DatabaseService still exists unchanged
[ ] Prisma packages are pinned to 7.10.0
[ ] package.json is not ESM
[ ] tsconfig module remains commonjs
[ ] generated Prisma Client is ignored
[ ] Prisma schema reflects existing DB rather than invented columns
[ ] 0_init contains no destructive migration
[ ] production baseline resolve was not executed
[ ] no production migration was deployed
[ ] disposable-db coexistence tests pass
[ ] full tests pass
[ ] lint passes
[ ] build passes
[ ] Docker build and health smoke pass
```

- [ ] **Step 8: Final phase checkpoint**

If Task 5 itself required no code changes, do not manufacture an empty commit.

If verification required a narrowly justified Docker change, commit only that fix:

```bash
git add Dockerfile
git commit -m "build(database): include generated Prisma client"
```

Then stop.

Do **not** begin Phase 0B or Rovelle product implementation in the same execution window.

---

# Phase 0A Completion Gate

Phase 0A is complete only when all of the following are true:

1. Prisma 7.10.0 is pinned and reproducible through `package-lock.json`.
2. The current CommonJS NestJS runtime is preserved.
3. Existing PostgreSQL schema is introspected into `prisma/schema.prisma`.
4. `prisma/migrations/0_init/migration.sql` faithfully baselines the existing schema.
5. No existing database was reset or destructively changed.
6. Production has **not** been marked with `migrate resolve` yet.
7. `PrismaService` can be absent/unconfigured without preventing Core startup.
8. `PrismaService` can create a Client when `DATABASE_URL` exists.
9. Prisma uses a capped separate PostgreSQL pool.
10. Raw `DatabaseService` and Prisma can query in the same process.
11. Raw `pg` timestamp parsing remains intact after loading the Prisma adapter.
12. Existing Veyra/Aegis tests are green.
13. Lint and build are green.
14. Docker build and no-database health boot are green.
15. No Rovelle product code has started.

After this gate passes, stop and review the Phase 0A result before creating or executing the **Phase 0B + Phase 1 Rovelle plan**.

---

# Terra / Luna Max Execution Assignment

Recommended delegation for the user's Codex setup:

```text
Terra (orchestrator)
  |
  +-- Task 1: own package/config integration
  |
  +-- Task 2: own baseline safety and schema review
  |
  +-- Task 3:
  |      Luna Max -> PrismaService unit implementation + tests
  |      Terra    -> review, env/AppModule integration
  |
  +-- Task 4:
  |      Luna Max -> coexistence integration test
  |      Terra    -> run disposable DB + review behavior
  |
  +-- Task 5: Terra final integration/verification
```

Do not parallelize Tasks 1 and 2 because baseline generation depends on the finalized Prisma configuration.

Do not parallelize Tasks 3 and 4 until `PrismaService` has a stable interface.

The best 5-hour usage shape is:

```text
Window A:
Task 1
Task 2
checkpoint

Window B, if needed:
Task 3
Task 4
Task 5
final Phase 0A checkpoint
```

If Window A finishes with low remaining Codex usage, stop after Task 2. The repository is stable at that checkpoint and Task 3 can resume cleanly in the next reset window.
