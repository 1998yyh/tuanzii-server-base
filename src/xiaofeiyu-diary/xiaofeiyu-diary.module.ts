import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { XiaofeiyuDiaryEntry } from './xiaofeiyu-diary.entity';
import { XiaofeiyuDiaryController } from './xiaofeiyu-diary.controller';
import { XiaofeiyuDiaryWebhookController } from './xiaofeiyu-diary-webhook.controller';
import { XiaofeiyuDiaryAdminGuard, XiaofeiyuDiaryWebhookGuard } from './xiaofeiyu-diary.guards';
import { XiaofeiyuDiaryService } from './xiaofeiyu-diary.service';

@Module({
  imports: [TypeOrmModule.forFeature([XiaofeiyuDiaryEntry])],
  controllers: [XiaofeiyuDiaryController, XiaofeiyuDiaryWebhookController],
  providers: [XiaofeiyuDiaryService, XiaofeiyuDiaryAdminGuard, XiaofeiyuDiaryWebhookGuard],
})
export class XiaofeiyuDiaryModule {}
