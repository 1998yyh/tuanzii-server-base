import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { UserRole } from '../users/users.entity';
import { LogStore, logDate } from './log-store';
import type { LogLevel } from './log-record';

export class QueryLogsDto {
  @ApiPropertyOptional({ example: '2026-09-14', description: '上海时区日期，默认今天，仅最近14天' })
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date: string = logDate();

  @ApiPropertyOptional({
    enum: ['info', 'warn', 'error', 'debug', 'fatal'],
    description: '日志级别',
  })
  @IsOptional()
  @IsIn(['info', 'warn', 'error', 'debug', 'fatal'])
  level?: LogLevel;

  @ApiPropertyOptional({ description: '会话 ID，精确匹配' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  conversationId?: string;

  @ApiPropertyOptional({ description: '请求 ID，精确匹配' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  requestId?: string;

  @ApiPropertyOptional({ example: 200, description: '每页条数，最多200条' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit: number = 200;

  @ApiPropertyOptional({ description: '上页返回的游标；筛选条件变化时清空' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  cursor?: string;
}

@Injectable()
export class LogsAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<{ user?: { role?: string } }>();
    if (request.user?.role !== UserRole.ADMIN)
      throw new ForbiddenException('仅管理员可查询系统日志');
    return true;
  }
}

@ApiTags('系统日志')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, LogsAdminGuard)
@Controller('admin/logs')
export class LogsController {
  constructor(private readonly store: LogStore) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: '管理员分页查询单日日志',
    description: '倒序返回，扫描受限时可用 nextCursor 继续；不支持文件路径或正则表达式',
  })
  @ApiResponse({ status: 200, description: '日志列表、下一页游标及扫描限制标记' })
  @ApiResponse({ status: 403, description: '仅管理员可访问' })
  @ApiResponse({ status: 429, description: '已有查询正在执行' })
  query(@Query() query: QueryLogsDto) {
    return this.store.query(query);
  }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '查看日志保留日期、容量与写入状态' })
  @ApiResponse({ status: 200, description: '日志存储状态，不包含宿主机路径' })
  @ApiResponse({ status: 403, description: '仅管理员可访问' })
  status() {
    return this.store.status();
  }
}
