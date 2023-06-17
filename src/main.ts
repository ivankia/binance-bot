import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import ENVIRONMENT from './env.loader';
import * as process from "process";

console.log('ENVIRONMENT', ENVIRONMENT);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(process.env.HTTP_PORT || 3000);
}
bootstrap();
