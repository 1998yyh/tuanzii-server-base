import type { Request } from 'express';
import {
  Body,
  Req,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { User, UserRole } from '../../users/users.entity';
import { SkillImportService } from './skill-import.service';
import { ImportSkillDto, PreviewSkillDto } from './skill-import.dto';
import { SKILL_MARKET } from './skill-market';
@ApiTags('Skill 导入')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('skills')
export class SkillImportController {
  constructor(private readonly imports: SkillImportService) {}
  @Get('market')
  @ApiOperation({ summary: '精选技能市场来源，不虚构下载量或评分' })
  market(@CurrentUser() user: Omit<User, 'password'>) {
    if (user.role !== UserRole.ADMIN) throw new ForbiddenException('仅管理员可管理技能');
    return { items: SKILL_MARKET };
  }
  @Post('imports/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '解析公开 GitHub Skill，预览技能及附带文件' })
  async preview(
    @CurrentUser() user: Omit<User, 'password'>,
    @Body() dto: PreviewSkillDto,
    @Req() request: Request,
  ) {
    const controller = new AbortController();
    const closed = () => {
      if (!request.res?.writableEnded) controller.abort();
    };
    request.res?.once('close', closed);
    try {
      return await this.imports.preview(user, dto, controller.signal);
    } finally {
      request.res?.off('close', closed);
    }
  }
  @Post('imports')
  @ApiOperation({ summary: '确认导入当前管理员已预览的不可变版本快照' })
  import(@CurrentUser() user: Omit<User, 'password'>, @Body() dto: ImportSkillDto) {
    return this.imports.import(user, dto);
  }
  @Delete('imports/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '丢弃当前管理员的技能导入预览' })
  discard(@CurrentUser() user: Omit<User, 'password'>, @Param('id', ParseUUIDPipe) id: string) {
    this.imports.discard(user, id);
  }
}
