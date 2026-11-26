#!/usr/bin/env node
/**
 * Prepare .env for Docker mode: create it from .env.example if missing and generate a random
 * POSTGRES_PASSWORD once (never hard-coded, never committed). Idempotent.
 */
import { randomBytes } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { findRepoRoot } from '@sss/config';

const root = findRepoRoot();
const envFile = join(root, '.env');
if (!existsSync(envFile)) copyFileSync(join(root, '.env.example'), envFile);
const content = readFileSync(envFile, 'utf8');
if (!/^POSTGRES_PASSWORD=.+$/m.test(content)) {
  appendFileSync(envFile, `\n# Generated for Docker mode (local only)\nPOSTGRES_PASSWORD=${randomBytes(24).toString('base64url')}\n`);
  console.log('[docker-env] Generated POSTGRES_PASSWORD in .env');
}
