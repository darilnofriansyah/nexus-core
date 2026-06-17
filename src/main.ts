import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { readEnv } from './config/env';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');

  const port = readEnv().port;
  await app.listen(port);
}

void bootstrap();

