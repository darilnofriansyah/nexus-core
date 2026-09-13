import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { readEnv } from "./config/env";
import { installBodyParsers } from "./config/body-parser";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.setGlobalPrefix("api");
  installBodyParsers(app);

  const port = readEnv().port;
  await app.listen(port);
}

void bootstrap();
