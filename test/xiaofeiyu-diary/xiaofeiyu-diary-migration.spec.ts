import { convertLegacyEntry } from '../../scripts/import-xiaofeiyu-sqlite';

describe('旧SQLite日记到共享后台的离线转换', () => {
  const row = {
    id: 1,
    title: '旧标题',
    text: '旧正文',
    created_at: '2026-10-28T00:00:00.000Z',
    is_read: 1,
  };

  it('保留原始正文、已读和实际时间，使用稳定UUID', () => {
    const first = convertLegacyEntry(row);
    expect(first.id).toMatch(/^[a-f0-9-]{14}5[a-f0-9-]{21}$/);
    expect(first).toEqual(convertLegacyEntry(row));
    expect(first.content).toBe('旧正文');
    expect(first.isRead).toBe(true);
    expect(first.createdAt?.toISOString()).toBe(row.created_at);
    expect(convertLegacyEntry({ ...row, id: 2 }).id).not.toBe(first.id);
  });

  it.each([
    { id: -1 },
    { text: '' },
    { title: 'x'.repeat(301) },
    { created_at: 'invalid' },
    { is_read: 2 },
  ])('无效行%j在连接目标库前失败', async (patch) => {
    expect(() => convertLegacyEntry({ ...row, ...patch })).toThrow('旧日记格式无效');
  });
});
