import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '20mb' });
  app.setGlobalPrefix('api/v1');
  const origins = process.env.CORS_ORIGINS?.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean) ?? ['http://localhost:3000'];
  app.enableCors({ origin: origins, credentials: true });
  await app.listen(Number(process.env.PORT ?? 3001));
}
void bootstrap();
