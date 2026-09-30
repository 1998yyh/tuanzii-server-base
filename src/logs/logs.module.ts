import { Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { LogStore } from './log-store';
import { FileLogger } from './file-logger';
import { LogsController, LogsAdminGuard } from './logs.controller';

@Module({
  providers: [
    {
      provide: LogStore,
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const directory = resolve(config.get<string>('LOG_DIRECTORY') || 'logs');
        const store = new LogStore({ directory });
        await store.initialize();
        return store;
      },
    },
    {
      provide: FileLogger,
      inject: [LogStore],
      useFactory: (store: LogStore) => new FileLogger(store),
    },
    LogsAdminGuard,
  ],
  controllers: [LogsController],
  exports: [FileLogger],
})
export class LogsModule implements OnApplicationShutdown {
  constructor(private readonly store: LogStore) {}
  async onApplicationShutdown() {
    await this.store.close();
  }
}
