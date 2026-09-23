import { CreateOrderDto } from '@ghostfolio/common/dtos';
import { UserWithSettings } from '@ghostfolio/common/types';

import { DataSource } from '@prisma/client';
import { setTimeout as sleep } from 'node:timers/promises';

import { ImportInProgressError } from './errors/import-in-progress.error';
import { ImportLockService } from './import-lock.service';
import { ImportService } from './import.service';

/**
 * Emulates the transaction-scoped PostgreSQL advisory lock of
 * ImportLockService (pg_try_advisory_xact_lock), including its release on
 * commit and rollback. The real database behavior is covered by
 * import-lock.service.integration.spec.ts.
 */
function createPrismaServiceWithAdvisoryLocks() {
  const heldLocks = new Set<string>();

  return {
    $transaction: async (callback: (transaction: unknown) => Promise<void>) => {
      const locksOfTransaction: string[] = [];

      const transaction = {
        $queryRaw: async (_strings: TemplateStringsArray, ...values: any[]) => {
          await sleep(1);

          if (values.length === 0) {
            // set_config() of the timeouts
            return [];
          }

          const key = values.join(':');

          if (heldLocks.has(key)) {
            return [{ locked: false }];
          }

          heldLocks.add(key);
          locksOfTransaction.push(key);

          return [{ locked: true }];
        }
      };

      try {
        return await callback(transaction);
      } finally {
        for (const key of locksOfTransaction) {
          heldLocks.delete(key);
        }
      }
    }
  };
}

/**
 * In-memory Order table with asynchronous (interleaving) reads and writes
 */
function createActivitiesService({
  failOnCreateCall
}: { failOnCreateCall?: number } = {}) {
  const orders: any[] = [];
  let createCalls = 0;

  return {
    orders,
    createActivity: jest.fn(async (data: any) => {
      createCalls++;

      await sleep(2);

      if (failOnCreateCall && createCalls === failOnCreateCall) {
        throw new Error('Connection lost');
      }

      const { dataSource, symbol } = data.SymbolProfile.connectOrCreate.create;

      const order = {
        accountId: data.accountId,
        comment: data.comment ?? null,
        currency: data.currency,
        date: data.date,
        fee: data.fee,
        id: `order-${orders.length + 1}`,
        quantity: data.quantity,
        SymbolProfile: {
          dataSource,
          symbol,
          currency: data.SymbolProfile.connectOrCreate.create.currency
        },
        type: data.type,
        unitPrice: data.unitPrice,
        userId: data.userId
      };

      orders.push(order);

      return order;
    }),
    getActivities: jest.fn(async () => {
      await sleep(2);

      return {
        activities: orders.map((order) => {
          return { ...order, assetProfile: order.SymbolProfile };
        })
      };
    })
  };
}

const assetProfileCurrencies: Record<string, string> = {
  bitcoin: 'USD',
  MSFT: 'USD',
  'NESN.SW': 'CHF'
};

function createImportService({
  activitiesService,
  importLockService
}: {
  activitiesService: ReturnType<typeof createActivitiesService>;
  importLockService: ImportLockService;
}) {
  const dataProviderService = {
    getDataSourceForImport: () => DataSource.YAHOO,
    validateActivities: jest.fn(async ({ activitiesDto }) => {
      await sleep(1);

      const assetProfiles = {};

      for (const { dataSource, symbol } of activitiesDto) {
        assetProfiles[JSON.stringify({ dataSource, symbol })] = {
          dataSource,
          symbol,
          currency: assetProfileCurrencies[symbol] ?? 'USD',
          name: symbol
        };
      }

      return assetProfiles;
    })
  };

  const importService = new ImportService(
    {
      accounts: async () => [],
      getAccounts: async () => [{ id: 'account-1', name: 'Account' }]
    } as any,
    activitiesService as any,
    {} as any,
    {
      get: (key: string) => {
        return key === 'MAX_ACTIVITIES_TO_IMPORT' ? 1000 : undefined;
      }
    } as any,
    { gatherSymbols: jest.fn() } as any,
    dataProviderService as any,
    { toCurrencyAtDate: async (value: number) => value } as any,
    importLockService,
    { updateMany: jest.fn() } as any,
    { getPlatforms: async () => [] } as any,
    {} as any,
    { add: jest.fn() } as any,
    { getTagsForUser: async () => [] } as any
  );

  return { dataProviderService, importService };
}

function createImportLockService() {
  const importLockService = new ImportLockService(
    createPrismaServiceWithAdvisoryLocks() as any
  );

  importLockService.pollInterval = 1;

  return importLockService;
}

function getActivitiesDto(): CreateOrderDto[] {
  return [
    {
      accountId: 'account-1',
      comment: null,
      currency: 'USD',
      dataSource: DataSource.YAHOO,
      date: '2024-01-02T00:00:00.000Z',
      fee: 1.5,
      quantity: 10,
      symbol: 'MSFT',
      type: 'BUY',
      unitPrice: 370
    },
    {
      accountId: 'account-1',
      currency: 'CHF',
      dataSource: DataSource.YAHOO,
      date: '2024-02-03T00:00:00.000Z',
      fee: 0,
      quantity: 5,
      symbol: 'NESN.SW',
      type: 'BUY',
      unitPrice: 98.5
    },
    {
      accountId: 'account-1',
      currency: 'USD',
      dataSource: DataSource.COINGECKO,
      date: '2024-03-04T00:00:00.000Z',
      fee: 2,
      quantity: 0.1,
      symbol: 'bitcoin',
      type: 'BUY',
      unitPrice: 62000
    },
    {
      accountId: 'account-1',
      currency: 'USD',
      dataSource: DataSource.YAHOO,
      date: '2024-05-15T00:00:00.000Z',
      fee: 0,
      quantity: 10,
      symbol: 'MSFT',
      type: 'DIVIDEND',
      unitPrice: 0.75
    },
    {
      accountId: 'account-1',
      currency: 'USD',
      date: '2024-06-30T00:00:00.000Z',
      fee: 0,
      quantity: 1,
      symbol: 'Interest',
      type: 'INTEREST',
      unitPrice: 12.34
    }
  ] as CreateOrderDto[];
}

const user = {
  id: 'user-1',
  permissions: [],
  settings: { settings: { baseCurrency: 'USD' } }
} as unknown as UserWithSettings;

function runImport(importService: ImportService) {
  // Every request gets its own (deserialized) payload
  return importService.import({
    accountsWithBalancesDto: [],
    activitiesDto: getActivitiesDto(),
    assetProfilesWithMarketDataDto: [],
    platformsDto: [],
    tagsDto: [],
    user
  });
}

describe('ImportService', () => {
  it('imports a unique file with mixed asset types as before', async () => {
    const activitiesService = createActivitiesService();
    const { importService } = createImportService({
      activitiesService,
      importLockService: createImportLockService()
    });

    const activities = await runImport(importService);

    expect(activities).toHaveLength(5);
    expect(activitiesService.orders).toHaveLength(5);

    expect(
      activitiesService.createActivity.mock.calls.map(([data]) => {
        return {
          currency: data.currency,
          dataSource: data.SymbolProfile.connectOrCreate.create.dataSource,
          fee: data.fee,
          quantity: data.quantity,
          symbol: data.SymbolProfile.connectOrCreate.create.symbol,
          type: data.type,
          unitPrice: data.unitPrice
        };
      })
    ).toEqual([
      {
        currency: 'USD',
        dataSource: DataSource.YAHOO,
        fee: 1.5,
        quantity: 10,
        symbol: 'MSFT',
        type: 'BUY',
        unitPrice: 370
      },
      {
        currency: 'CHF',
        dataSource: DataSource.YAHOO,
        fee: 0,
        quantity: 5,
        symbol: 'NESN.SW',
        type: 'BUY',
        unitPrice: 98.5
      },
      {
        currency: 'USD',
        dataSource: DataSource.COINGECKO,
        fee: 2,
        quantity: 0.1,
        symbol: 'bitcoin',
        type: 'BUY',
        unitPrice: 62000
      },
      {
        currency: 'USD',
        dataSource: DataSource.YAHOO,
        fee: 0,
        quantity: 10,
        symbol: 'MSFT',
        type: 'DIVIDEND',
        unitPrice: 0.75
      },
      {
        // A non-investment activity without data source falls back to MANUAL
        currency: 'USD',
        dataSource: DataSource.MANUAL,
        fee: 0,
        quantity: 1,
        symbol: 'Interest',
        type: 'INTEREST',
        unitPrice: 12.34
      }
    ]);

    expect(activities.map(({ value }) => value)).toEqual([
      3700, 492.5, 6200, 7.5, 12.34
    ]);
  });

  it('does not duplicate activities on a retry of the same import', async () => {
    const activitiesService = createActivitiesService();
    const { importService } = createImportService({
      activitiesService,
      importLockService: createImportLockService()
    });

    await runImport(importService);
    const activitiesOfRetry = await runImport(importService);

    // Existing behavior: duplicates are skipped, so nothing new is returned
    expect(activitiesOfRetry).toEqual([]);
    expect(activitiesService.orders).toHaveLength(5);
  });

  it('creates duplicates for concurrent identical imports without the lock (bug)', async () => {
    const activitiesService = createActivitiesService();
    const { importService } = createImportService({
      activitiesService,
      importLockService: {
        runExclusively: ({ fn }) => fn()
      } as ImportLockService
    });

    await Promise.all(
      Array.from({ length: 5 }, () => {
        return runImport(importService);
      })
    );

    // Every request passes the duplicate detection before any activity exists
    expect(activitiesService.orders).toHaveLength(25);
  });

  it('does not duplicate activities on concurrent identical imports', async () => {
    const activitiesService = createActivitiesService();
    const { importService } = createImportService({
      activitiesService,
      importLockService: createImportLockService()
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        return runImport(importService);
      })
    );

    expect(activitiesService.orders).toHaveLength(5);

    // Exactly one request creates the activities, the others skip duplicates
    expect(
      results
        .map(({ length }) => {
          return length;
        })
        .sort()
    ).toEqual([0, 0, 0, 0, 5]);
  });

  it('completes an import on retry after a partial failure without duplicates', async () => {
    const activitiesService = createActivitiesService({
      failOnCreateCall: 3
    });
    const { importService } = createImportService({
      activitiesService,
      importLockService: createImportLockService()
    });

    await expect(runImport(importService)).rejects.toThrow('Connection lost');

    // The import is not atomic, the first two activities remain
    expect(activitiesService.orders).toHaveLength(2);

    const activitiesOfRetry = await runImport(importService);

    expect(activitiesOfRetry).toHaveLength(3);
    expect(activitiesService.orders).toHaveLength(5);
    expect(
      new Set(
        activitiesService.orders.map(({ date, SymbolProfile, type }) => {
          return `${SymbolProfile.symbol}-${type}-${date.toISOString()}`;
        })
      ).size
    ).toBe(5);
  });

  it('does not take the lock for a dry run', async () => {
    const activitiesService = createActivitiesService();
    const importLockService = createImportLockService();
    const runExclusively = jest.spyOn(importLockService, 'runExclusively');
    const { importService } = createImportService({
      activitiesService,
      importLockService
    });

    const activities = await importService.import({
      accountsWithBalancesDto: [],
      activitiesDto: getActivitiesDto(),
      assetProfilesWithMarketDataDto: [],
      isDryRun: true,
      platformsDto: [],
      tagsDto: [],
      user
    });

    expect(activities).toHaveLength(5);
    expect(activitiesService.orders).toHaveLength(0);
    expect(runExclusively).not.toHaveBeenCalled();
  });
});

describe('ImportLockService', () => {
  it('rejects with ImportInProgressError if the lock is not released in time', async () => {
    const importLockService = createImportLockService();
    importLockService.acquireTimeout = 20;

    let release: () => void;
    const holder = importLockService.runExclusively({
      fn: () => {
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      userId: 'user-1'
    });

    await sleep(5);

    await expect(
      importLockService.runExclusively({
        fn: async () => {
          return undefined;
        },
        userId: 'user-1'
      })
    ).rejects.toBeInstanceOf(ImportInProgressError);

    // Other users are not blocked
    await expect(
      importLockService.runExclusively({
        fn: async () => 'ok',
        userId: 'user-2'
      })
    ).resolves.toBe('ok');

    release();
    await holder;
  });

  it('releases the lock if the function throws', async () => {
    const importLockService = createImportLockService();

    await expect(
      importLockService.runExclusively({
        fn: async () => {
          throw new Error('Failure');
        },
        userId: 'user-1'
      })
    ).rejects.toThrow('Failure');

    await expect(
      importLockService.runExclusively({
        fn: async () => 'ok',
        userId: 'user-1'
      })
    ).resolves.toBe('ok');
  });
});
