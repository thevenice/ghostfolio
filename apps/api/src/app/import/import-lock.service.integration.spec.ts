import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { setTimeout as sleep } from 'node:timers/promises';

import { ImportLockService } from './import-lock.service';

/**
 * Runs against a real PostgreSQL database to verify that the advisory lock
 * serializes a check-then-insert across independent clients (i.e. across
 * application instances). Skipped unless IMPORT_LOCK_TEST_DATABASE_URL is set.
 */
const databaseUrl = process.env.IMPORT_LOCK_TEST_DATABASE_URL;

(databaseUrl ? describe : describe.skip)(
  'ImportLockService (PostgreSQL)',
  () => {
    const tableName = 'import_lock_integration_test';
    let prismaClients: PrismaClient[];

    beforeAll(async () => {
      // Two clients with their own connection pools act as two instances
      prismaClients = [0, 1].map(() => {
        return new PrismaClient({
          adapter: new PrismaPg({ connectionString: databaseUrl })
        });
      });

      await prismaClients[0].$executeRawUnsafe(
        `CREATE TABLE IF NOT EXISTS ${tableName} ("userId" text NOT NULL, "key" text NOT NULL)`
      );
    });

    beforeEach(async () => {
      await prismaClients[0].$executeRawUnsafe(`TRUNCATE ${tableName}`);
    });

    afterAll(async () => {
      await prismaClients[0].$executeRawUnsafe(`DROP TABLE ${tableName}`);

      await Promise.all(
        prismaClients.map((prismaClient) => {
          return prismaClient.$disconnect();
        })
      );
    });

    // The same check-then-insert as the duplicate detection of the import
    async function importRows({
      prismaClient,
      userId
    }: {
      prismaClient: PrismaClient;
      userId: string;
    }) {
      let created = 0;

      for (const key of ['a', 'b', 'c']) {
        const existing = await prismaClient.$queryRawUnsafe<unknown[]>(
          `SELECT 1 FROM ${tableName} WHERE "userId" = $1 AND "key" = $2`,
          userId,
          key
        );

        await sleep(5);

        if (existing.length === 0) {
          await prismaClient.$executeRawUnsafe(
            `INSERT INTO ${tableName} ("userId", "key") VALUES ($1, $2)`,
            userId,
            key
          );

          created++;
        }
      }

      return created;
    }

    async function countRows() {
      const [{ count }] = await prismaClients[0].$queryRawUnsafe<
        { count: bigint }[]
      >(`SELECT COUNT(*) AS count FROM ${tableName}`);

      return Number(count);
    }

    it('creates duplicates without the lock (race condition)', async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_, index) => {
          return importRows({
            prismaClient: prismaClients[index % 2],
            userId: 'user-1'
          });
        })
      );

      expect(await countRows()).toBeGreaterThan(3);
    });

    it('serializes concurrent identical imports across instances', async () => {
      const importLockServices = prismaClients.map((prismaClient) => {
        const importLockService = new ImportLockService(prismaClient as any);
        importLockService.pollInterval = 10;

        return importLockService;
      });

      const results = await Promise.all(
        Array.from({ length: 5 }, (_, index) => {
          const prismaClient = prismaClients[index % 2];

          return importLockServices[index % 2].runExclusively({
            fn: () => {
              return importRows({ prismaClient, userId: 'user-1' });
            },
            userId: 'user-1'
          });
        })
      );

      expect(results.sort()).toEqual([0, 0, 0, 0, 3]);
      expect(await countRows()).toBe(3);
    });

    it('releases the lock on a failure, so that a retry can proceed', async () => {
      const importLockService = new ImportLockService(prismaClients[0] as any);

      await expect(
        importLockService.runExclusively({
          fn: async () => {
            await importRows({
              prismaClient: prismaClients[0],
              userId: 'user-1'
            });

            throw new Error('Failure');
          },
          userId: 'user-1'
        })
      ).rejects.toThrow('Failure');

      const created = await new ImportLockService(
        prismaClients[1] as any
      ).runExclusively({
        fn: () => {
          return importRows({
            prismaClient: prismaClients[1],
            userId: 'user-1'
          });
        },
        userId: 'user-1'
      });

      expect(created).toBe(0);
      expect(await countRows()).toBe(3);
    });
  }
);
