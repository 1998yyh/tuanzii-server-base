import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  Get,
  Header,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  ForbiddenException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { BrowserSessionsService } from './browser-sessions.service';
import type { SessionRequest } from './browser-sessions.service';
import { CreateBrowserSessionDto } from './browser-session.dto';

@Injectable()
export class BrowserSessionGuard implements CanActivate {
  constructor(private readonly sessions: BrowserSessionsService) {}
  async canActivate(context: ExecutionContext) {
    await this.sessions.authenticate(context.switchToHttp().getRequest<SessionRequest>());
    return true;
  }
}

@ApiTags('统一登录与设备会话')
@ApiResponse({ status: 401, description: '登录失效' })
@ApiResponse({ status: 403, description: '来源、请求校验或权限不符合要求' })
@Controller('auth')
export class BrowserSessionsController {
  constructor(private readonly sessions: BrowserSessionsService) {}

  @Post('session')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '登录并创建浏览器会话，不返回访问令牌' })
  create(
    @Body() dto: CreateBrowserSessionDto,
    @Req() request: SessionRequest,
    @Res({ passthrough: true }) response: Response,
  ) {
    return this.sessions.create(dto, request, response);
  }

  @Get('session')
  @UseGuards(BrowserSessionGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '查询当前身份、项目权限和请求校验令牌' })
  current(@Req() request: SessionRequest) {
    return this.sessions.view(request.browserSession!, request.user!);
  }

  @Delete('session')
  @UseGuards(BrowserSessionGuard)
  @HttpCode(204)
  @ApiOperation({ summary: '撤销当前设备会话' })
  async logout(@Req() request: SessionRequest, @Res({ passthrough: true }) response: Response) {
    await this.sessions.revoke(request.browserSession!);
    this.sessions.clearCookie(response);
  }

  @Post('logout-all')
  @UseGuards(BrowserSessionGuard)
  @HttpCode(204)
  @ApiOperation({ summary: '撤销全部设备会话' })
  async logoutAll(@Req() request: SessionRequest, @Res({ passthrough: true }) response: Response) {
    await this.sessions.revokeAll(request.browserSession!);
    this.sessions.clearCookie(response);
  }

  @Get('sessions')
  @UseGuards(BrowserSessionGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: '列出当前用户的有效设备会话' })
  list(@Req() request: SessionRequest) {
    return this.sessions.list(request.browserSession!);
  }

  @Delete('sessions/:id')
  @UseGuards(BrowserSessionGuard)
  @HttpCode(204)
  @ApiOperation({ summary: '撤销属于当前用户的指定设备会话' })
  async revoke(
    @Req() request: SessionRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.sessions.revoke(request.browserSession!, id);
    if (id === request.browserSession!.id) this.sessions.clearCookie(response);
  }

  @Get('dsh-access')
  @UseGuards(BrowserSessionGuard)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'dsh 适配层检查会话与单独授权，不返回 dsh 凭据' })
  async dshAccess(@Req() request: SessionRequest) {
    const view = await this.sessions.view(request.browserSession!, request.user!);
    if (!view.apps.includes('dsh')) throw new ForbiddenException('此账号没有 dsh 访问权限');
    return { userId: view.user.id, sessionId: request.browserSession!.id };
  }
}
