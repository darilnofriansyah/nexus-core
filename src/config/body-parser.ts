import type { INestApplication } from "@nestjs/common";
import { json, urlencoded } from "express";
import { readEnv } from "./env";

const DEFAULT_BODY_LIMIT_BYTES = 100 * 1024;

export function installBodyParsers(app: INestApplication): void {
  app.use(
    "/api/rovelle/creative-jobs",
    json({ limit: readEnv().rovelleCreativeBodyLimitBytes }),
  );
  app.use(json({ limit: DEFAULT_BODY_LIMIT_BYTES }));
  app.use(urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT_BYTES }));
}
