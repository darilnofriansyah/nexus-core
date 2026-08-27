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
