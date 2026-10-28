import {
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { QueryXiaofeiyuDiaryDto } from './dto/xiaofeiyu-diary.dto';
import { XiaofeiyuDiaryAdminGuard } from './xiaofeiyu-diary.guards';
import { XiaofeiyuDiaryService } from './xiaofeiyu-diary.service';

@ApiTags('小肥鱼日记')
@ApiBearerAuth()
@ApiResponse({ status: 401, description: '需要有效登录身份' })
@ApiResponse({ status: 403, description: '仅管理员可访问' })
@UseGuards(JwtAuthGuard, XiaofeiyuDiaryAdminGuard)
@Controller('xiaofeiyu')
export class XiaofeiyuDiaryController {
  constructor(private readonly diary: XiaofeiyuDiaryService) {}

  @Get('entries')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '分页阅读小肥鱼日记', description: '多管理员共享一本日记与已读状态' })
  @ApiResponse({ status: 200, description: '日记、分页信息、全局总数与未读数' })
  @ApiResponse({ status: 400, description: '分页或筛选参数无效' })
  findAll(@Query() query: QueryXiaofeiyuDiaryDto) {
    return this.diary.findAll(query);
  }

  @Post('entries/read-all')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '将全部日记标记为已读' })
  @ApiResponse({ status: 201, description: '全部标记已读，重复调用安全' })
  markAllRead() {
    return this.diary.markAllRead();
  }

  @Post('entries/:id/read')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '将单篇日记标记为已读' })
  @ApiResponse({ status: 201, description: '已读状态保存成功' })
  @ApiResponse({ status: 400, description: '日记ID不是有效UUID' })
  @ApiResponse({ status: 404, description: '日记不存在' })
  markRead(@Param('id', ParseUUIDPipe) id: string) {
    return this.diary.markRead(id);
  }
}
