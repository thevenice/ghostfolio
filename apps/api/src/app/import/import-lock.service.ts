import { PrismaService } from '@ghostfolio/api/services/prisma/prisma.service';

import { Injectable } from '@nestjs/common';
import ms from 'ms';
import { setTimeout as sleep } from 'node:timers/promises';

import { ImportInProgressError } from './errors/import-in-progress.error';

/**
 * Namespace (first key) of the PostgreSQL advisory lock, so that the lock of
 * an import does not collide with other advisory locks in the same database
 */
export const IMPORT_LOCK_NAMESPACE = 1_601_202_609;

@Injectable()
export class ImportLockService {
  // How long a request waits for the import of the same user to finish
  public acquireTimeout = ms('2 minutes');

  // How long an import may hold the lock (upper bound of an import)
  public lockTimeout = ms('15 minutes');

  public pollInterval = 250;

  public constructor(private readonly prismaService: PrismaService) {}

  /**
   * Runs the given function while holding a transaction-scoped PostgreSQL
   * advisory lock of the user. The lock is held by the database, so it is
   * shared by all instances of the application, and it is released
   * automatically on commit, rollback or if the connection is lost (e.g. the
   * instance crashes).
   *
   * The lock is acquired with pg_try_advisory_xact_lock() in a loop instead of
   * the blocking pg_advisory_xact_lock(), so that waiting requests do not keep
   * connections of the pool busy, which the import holding the lock needs.
   */
  public async runExclusively<T>({
    fn,
    userId
  }: {
    fn: () => Promise<T>;
    userId: string;
  }): Promise<T> {
    const deadline = Date.now() + this.acquireTimeout;

    while (true) {
      let isAcquired = false;
      let result: T;

      await this.prismaService.$transaction(
        async (transaction) => {
          const [{ locked }] = await transaction.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(${IMPORT_LOCK_NAMESPACE}::integer, hashtext(${userId})) AS locked`;

          if (!locked) {
            return;
          }

          isAcquired = true;

          // The function uses its own connections, the transaction only keeps
          // the lock until the function has completed
          result = await fn();
        },
        { maxWait: this.acquireTimeout, timeout: this.lockTimeout }
      );

      if (isAcquired) {
        return result;
      }

      if (Date.now() >= deadline) {
        throw new ImportInProgressError();
      }

      await sleep(this.pollInterval);
    }
  }
}
