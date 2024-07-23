import { INestApplication, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DIService, IDependencyRegistryEngine, InstanceOf } from 'discordx';
import { AppModule } from 'src/app.module';
import { DiscordService } from 'src/services/discord.service';

export class NoopRegistryEngine implements IDependencyRegistryEngine {
  addService(): void {}
  clearAllServices(): void {}
  getAllServices(): Set<unknown> {
    return new Set();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getService<T>(_classType: T): InstanceOf<T> | null {
    console.log('NoopRegistryEngine.getService');
    return null;
  }
}

export class NestjsRegistryEngine extends NoopRegistryEngine {
  constructor(private app: INestApplication) {
    super();
  }

  getService<T>(classType: T): InstanceOf<T> | null {
    return this.app.get(classType as any);
  }
}

async function bootstrap() {
  const logger = new Logger('Main');
  const port = Number(process.env.IMMICH_PORT) || 8080;

  DIService.engine = new NoopRegistryEngine();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { cors: true });
  DIService.engine = new NestjsRegistryEngine(app);

  await app.get(DiscordService).init();
  await app.listen(port);
  logger.log(`Immich Api is running on: ${await app.getUrl()}`);
}

void bootstrap();
