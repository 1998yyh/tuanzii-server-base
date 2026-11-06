import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { User, UserRole } from '../../users/users.entity';
import { GithubSkillsService } from './github-skills.service';
import { SkillsService } from '../skills.service';
import type { SkillView } from '../skill.entity';
import type { SkillPackage } from './skill-package.types';
import { ImportSkillDto, PreviewSkillDto } from './skill-import.dto';
@Injectable()
export class SkillImportService {
  private readonly previews = new Map<
    string,
    { userId: string; expires: number; skill: SkillPackage; importing: boolean }
  >();
  private readonly completed = new Map<
    string,
    { userId: string; expires: number; result: SkillView }
  >();
  constructor(
    private readonly github: GithubSkillsService,
    private readonly skills: SkillsService,
  ) {}
  private admin(user: Omit<User, 'password'>) {
    if (user.role !== UserRole.ADMIN) throw new ForbiddenException('仅管理员可以导入技能');
  }
  async preview(user: Omit<User, 'password'>, dto: PreviewSkillDto, signal?: AbortSignal) {
    this.admin(user);
    const result = await this.github.preview(user.id, dto.url, dto.ref, signal);
    if (signal?.aborted) throw new BadRequestException('技能解析已取消');
    if (result.kind === 'choose') return result;
    for (const [id, item] of this.previews)
      if (item.expires <= Date.now() && !item.importing) this.previews.delete(id);
    // 单实例预览缓存有总量和每用户上限；使用确认时的快照，不重新抓取移动分支。
    const own = [...this.previews.entries()].filter(
      ([, item]) => item.userId === user.id && !item.importing,
    );
    if (own.length >= 3) this.previews.delete(own[0][0]);
    if (this.previews.size >= 12) throw new BadRequestException('待确认的技能预览较多，请稍后重试');
    const previewId = randomUUID(),
      expires = Date.now() + 10 * 60_000;
    this.previews.set(previewId, {
      userId: user.id,
      expires,
      skill: result.skill,
      importing: false,
    });
    return { ...result, previewId, expiresAt: new Date(expires).toISOString() };
  }
  async import(user: Omit<User, 'password'>, dto: ImportSkillDto) {
    this.admin(user);
    const completed = this.completed.get(dto.previewId);
    if (completed?.userId === user.id && completed.expires > Date.now()) return completed.result;
    const item = this.previews.get(dto.previewId);
    if (!item || item.userId !== user.id || item.expires <= Date.now())
      throw new BadRequestException('预览已过期或不可访问，请重新解析技能');
    if (item.importing) throw new BadRequestException('技能正在导入，请稍候');
    item.importing = true;
    try {
      const result = await this.skills.create(
        user,
        {
          name: dto.name.trim(),
          description: dto.description.trim(),
          systemPrompt: item.skill.systemPrompt,
        },
        { source: item.skill.source, files: item.skill.files },
      );
      this.previews.delete(dto.previewId);
      if (this.completed.size >= 64) this.completed.delete(this.completed.keys().next().value!);
      this.completed.set(dto.previewId, { userId: user.id, expires: item.expires, result });
      return result;
    } finally {
      item.importing = false;
    }
  }
  discard(user: Omit<User, 'password'>, id: string) {
    this.admin(user);
    const item = this.previews.get(id);
    if (item?.userId === user.id && !item.importing) this.previews.delete(id);
  }
}
