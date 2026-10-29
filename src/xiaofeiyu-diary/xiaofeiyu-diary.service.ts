import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { XiaofeiyuDiaryEntry } from './xiaofeiyu-diary.entity';
import { QueryXiaofeiyuDiaryDto, ReceiveXiaofeiyuDiaryDto } from './dto/xiaofeiyu-diary.dto';

export interface XiaofeiyuDiaryView {
  id: string;
  title: string;
  text: string;
  createdAt: string;
  read: boolean;
}

@Injectable()
export class XiaofeiyuDiaryService {
  constructor(
    @InjectRepository(XiaofeiyuDiaryEntry)
    private readonly repository: Repository<XiaofeiyuDiaryEntry>,
  ) {}

  async receive(dto: ReceiveXiaofeiyuDiaryDto) {
    const title = dto.title?.trim() || '小肥鱼的碎碎念';
    let content = (dto.text || dto.content || '').trimStart();
    if (content.startsWith(title + '\n')) content = content.slice(title.length + 1).trimStart();
    content = content.trim();
    if (!content) throw new BadRequestException('日记正文不能为空');
    // 插件的检查通知与日记共用推送通道；确认接收但不将系统通知写进日记。
    if (title === '分享前评论检查') {
      return { ok: true, ignored: true, reason: '分享前评论检查通知不写入日记' };
    }
    const entry = await this.repository.save(
      this.repository.create({ title, content, isRead: false }),
    );
    return { ok: true, id: entry.id };
  }

  async findAll(query: QueryXiaofeiyuDiaryDto) {
    const { page = 1, limit = 30, q, unread } = query;
    const builder = this.repository.createQueryBuilder('diary');
    if (unread === '1') builder.andWhere('diary.isRead = :isRead', { isRead: false });
    if (q) {
      // LOCATE 做字面量包含匹配，百分号和下划线不会变成 LIKE 通配符。
      builder.andWhere('(LOCATE(:q, diary.title) > 0 OR LOCATE(:q, diary.content) > 0)', { q });
    }
    builder
      .orderBy('diary.createdAt', 'DESC')
      .addOrderBy('diary.id', 'DESC')
      .skip((page - 1) * limit)
      .take(limit);
    const [[entries, total], allTotal, unreadCount] = await Promise.all([
      builder.getManyAndCount(),
      this.repository.count(),
      this.repository.count({ where: { isRead: false } }),
    ]);
    const totalPages = Math.ceil(total / limit);
    return {
      items: entries.map(
        (entry): XiaofeiyuDiaryView => ({
          id: entry.id,
          title: entry.title,
          text: entry.content,
          createdAt: entry.createdAt.toISOString(),
          read: entry.isRead,
        }),
      ),
      total,
      page,
      limit,
      totalPages,
      allTotal,
      unread: unreadCount,
      hasMore: page < totalPages,
    };
  }

  async markRead(id: string) {
    const entry = await this.repository.findOne({ where: { id } });
    if (!entry) throw new NotFoundException(`日记 #${id} 不存在`);
    if (!entry.isRead) await this.repository.update({ id, isRead: false }, { isRead: true });
    return { ok: true };
  }

  async markAllRead() {
    await this.repository.update({ isRead: false }, { isRead: true });
    return { ok: true };
  }
}
