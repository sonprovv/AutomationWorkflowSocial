import { defineConfig } from 'prisma/config';

// Prisma 7 config. DATABASE_URL comes from the environment (start scripts / .env / test harness).
// A placeholder keeps `prisma generate` working without a database.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? 'postgresql://placeholder:placeholder@127.0.0.1:5432/placeholder' },
});
