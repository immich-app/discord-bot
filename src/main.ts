import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from 'src/app.module';

async function bootstrap() {
  const logger = new Logger('Main');
  const port = Number(process.env.IMMICH_PORT) || 8080;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true });

  await app.listen(port);
  logger.log(`Immich Api is running on: ${await app.getUrl()}`);
}

void bootstrap();
