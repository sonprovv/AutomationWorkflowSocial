import type { AppConfig } from '@sss/config';
import type { Db } from '@sss/database';
import type { JobDispatcher } from '@sss/queue';

export interface Logger {
  debug(obj: object | string, msg?: string): void;
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** Everything a service needs. Built once per process (API / worker / scheduler / tests). */
export interface ServiceContext {
  db: Db;
  config: AppConfig;
  dispatcher: JobDispatcher;
  logger: Logger;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export const nowOf = (ctx: ServiceContext): Date => (ctx.now ? ctx.now() : new Date());
