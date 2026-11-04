import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsersModule } from '../users/users.module';
import { BrowserSession, UserAppGrant } from './browser-session.entity';
import { BrowserSessionsService } from './browser-sessions.service';
import { BrowserSessionGuard, BrowserSessionsController } from './browser-sessions.controller';

@Global()
@Module({
  imports: [UsersModule, TypeOrmModule.forFeature([BrowserSession, UserAppGrant])],
  providers: [BrowserSessionsService, BrowserSessionGuard],
  controllers: [BrowserSessionsController],
  exports: [BrowserSessionsService],
})
export class BrowserSessionsModule {}
