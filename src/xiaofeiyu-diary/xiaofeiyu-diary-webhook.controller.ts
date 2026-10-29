import { Body, Controller, Header, HttpStatus, Post, Query, Res, UseGuards } from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  ReceiveXiaofeiyuDiaryDto,
  XiaofeiyuWebhookCredentialsDto,
} from './dto/xiaofeiyu-diary.dto';
import { XiaofeiyuDiaryWebhookGuard } from './xiaofeiyu-diary.guards';
import { XiaofeiyuDiaryService } from './xiaofeiyu-diary.service';

@ApiTags('小肥鱼日记内部推送')
@Controller('internal/xiaofeiyu')
export class XiaofeiyuDiaryWebhookController {
  constructor(private readonly diary: XiaofeiyuDiaryService) {}

  @Post('webhook')
  @Header('Cache-Control', 'no-store')
  @UseGuards(XiaofeiyuDiaryWebhookGuard)
  @ApiHeader({ name: 'X-Xiaofeiyu-Key', required: false, description: '日记推送密钥，优先于query' })
  @ApiOperation({
    summary: '接收小肥鱼日记摘要',
    description: '仅供服务器本机直连，公网Nginx必须阻断该路径',
  })
  @ApiResponse({ status: 201, description: '日记持久化成功，仅返回ID' })
  @ApiResponse({ status: 200, description: '分享前评论检查通知已接收并忽略，不写入日记' })
  @ApiResponse({ status: 400, description: '正文为空、字段无效或包含未声明字段' })
  @ApiResponse({ status: 403, description: '推送密钥无效' })
  @ApiResponse({ status: 503, description: '尚未配置有效推送密钥' })
  async receive(
    @Body() body: ReceiveXiaofeiyuDiaryDto,
    @Query() _credentials: XiaofeiyuWebhookCredentialsDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.diary.receive(body);
    if ('ignored' in result) response.status(HttpStatus.OK);
    return result;
  }
}
