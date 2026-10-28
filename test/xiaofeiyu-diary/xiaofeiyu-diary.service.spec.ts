import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { XiaofeiyuDiaryEntry } from 'src/xiaofeiyu-diary/xiaofeiyu-diary.entity';
import { XiaofeiyuDiaryService } from 'src/xiaofeiyu-diary/xiaofeiyu-diary.service';
import { QueryXiaofeiyuDiaryDto } from 'src/xiaofeiyu-diary/dto/xiaofeiyu-diary.dto';

const id = '11111111-1111-4111-8111-111111111111';

describe('小肥鱼日记业务服务', () => {
  let service: XiaofeiyuDiaryService;
  let repository: Record<string, jest.Mock>;
  let query: Record<string, jest.Mock>;

  beforeEach(async () => {
    query = {
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    };
    repository = {
      create: jest.fn((value) => value),
      save: jest.fn(async (value) => ({ ...value, id })),
      createQueryBuilder: jest.fn(() => query),
      count: jest.fn().mockResolvedValue(0),
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const module = await Test.createTestingModule({
      providers: [
        XiaofeiyuDiaryService,
        { provide: getRepositoryToken(XiaofeiyuDiaryEntry), useValue: repository },
      ],
    }).compile();
    service = module.get(XiaofeiyuDiaryService);
  });

  it('去掉重复标题并将正文以纯文本保存', async () => {
    await expect(service.receive({ title: ' 日记 ', text: '日记\n今天很好。' })).resolves.toEqual({
      ok: true,
      id,
    });
    expect(repository.create).toHaveBeenCalledWith({
      title: '日记',
      content: '今天很好。',
      isRead: false,
    });
  });

  it('支持备用正文与默认标题', async () => {
    await service.receive({ content: '  备用正文  ' });
    expect(repository.create).toHaveBeenCalledWith({
      title: '小肥鱼的碎碎念',
      content: '备用正文',
      isRead: false,
    });
  });

  it('text优先且HTML保持字面量，不执行或渲染正文', async () => {
    await service.receive({ text: '<script>test</script>', content: '备用', format: 'markdown' });
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: '<script>test</script>' }),
    );
  });

  it.each([{}, { text: '   ' }, { title: '标题', text: '标题\n  ' }])(
    '拒绝空正文%j且不写数据库',
    async (body) => {
      await expect(service.receive(body)).rejects.toBeInstanceOf(BadRequestException);
      expect(repository.save).not.toHaveBeenCalled();
    },
  );

  it('写入失败不能返回投递成功', async () => {
    repository.save.mockRejectedValue(new Error('数据库测试失败'));
    await expect(service.receive({ text: '正文' })).rejects.toThrow('数据库测试失败');
  });

  it('使用项目分页约定与参数化字面量搜索，返回显式View', async () => {
    query.getManyAndCount.mockResolvedValue([
      [
        {
          id,
          title: '标题',
          content: '正文',
          isRead: false,
          createdAt: new Date('2026-10-28T00:00:00Z'),
          updatedAt: new Date(),
        },
      ],
      65,
    ]);
    repository.count.mockResolvedValueOnce(100).mockResolvedValueOnce(40);
    const result = await service.findAll(
      Object.assign(new QueryXiaofeiyuDiaryDto(), {
        page: 3,
        limit: 30,
        unread: '1',
        q: "%_' OR 1=1",
      }),
    );
    expect(query.skip).toHaveBeenCalledWith(60);
    expect(query.take).toHaveBeenCalledWith(30);
    expect(query.andWhere).toHaveBeenCalledWith('diary.isRead = :isRead', { isRead: false });
    expect(query.andWhere).toHaveBeenCalledWith(expect.stringContaining('LOCATE(:q'), {
      q: "%_' OR 1=1",
    });
    expect(result).toMatchObject({
      total: 65,
      page: 3,
      limit: 30,
      totalPages: 3,
      allTotal: 100,
      unread: 40,
      hasMore: false,
    });
    expect(result.items).toEqual([
      { id, title: '标题', text: '正文', createdAt: '2026-10-28T00:00:00.000Z', read: false },
    ]);
  });

  it('未使用筛选时不拼接额外条件', async () => {
    await service.findAll(new QueryXiaofeiyuDiaryDto());
    expect(query.andWhere).not.toHaveBeenCalled();
    expect(query.skip).toHaveBeenCalledWith(0);
  });

  it('不存在的日记返回404', async () => {
    await expect(service.markRead(id)).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.update).not.toHaveBeenCalled();
  });

  it('已读操作幂等，未读条目通过条件更新', async () => {
    repository.findOne
      .mockResolvedValueOnce({ id, isRead: false })
      .mockResolvedValueOnce({ id, isRead: true });
    await expect(service.markRead(id)).resolves.toEqual({ ok: true });
    await expect(service.markRead(id)).resolves.toEqual({ ok: true });
    expect(repository.update).toHaveBeenCalledTimes(1);
    expect(repository.update).toHaveBeenCalledWith({ id, isRead: false }, { isRead: true });
  });

  it('全部已读只更新未读条目，保持多管理员共享语义', async () => {
    await expect(service.markAllRead()).resolves.toEqual({ ok: true });
    expect(repository.update).toHaveBeenCalledWith({ isRead: false }, { isRead: true });
  });
});
