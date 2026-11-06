import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  try {
    process.loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  const origins = process.env.CORS_ORIGINS?.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins?.length) app.enableCors({ origin: origins, credentials: true });
  await app.listen(Number(process.env.PORT ?? 3001));
}
void bootstrap();
