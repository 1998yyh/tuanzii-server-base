/** 显式离线迁移入口。默认只读校验，不连接MySQL；--apply才使用项目环境配置。 */
import { ConfigModule } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DataSource } from 'typeorm';
import { XiaofeiyuDiaryEntry } from '../src/xiaofeiyu-diary/xiaofeiyu-diary.entity';

export interface LegacyDiaryRow {
  id: number;
  title: string;
  text: string;
  created_at: string;
  is_read: number;
}

export function convertLegacyEntry(row: LegacyDiaryRow): Partial<XiaofeiyuDiaryEntry> {
  const createdAt = new Date(row.created_at);
  if (
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.title !== 'string' ||
    !row.title.trim() ||
    row.title.length > 300 ||
    typeof row.text !== 'string' ||
    !row.text.trim() ||
    row.text.length > 100000 ||
    ![0, 1].includes(row.is_read) ||
    !Number.isFinite(createdAt.getTime())
  )
    throw new Error('旧日记格式无效，迁移已停止');
  // 确定性UUID保证重复运行只跳过旧记录，不覆写MySQL中已经更新的已读状态。
  const bytes = createHash('sha256')
    .update(`xiaofeiyu-diary/sqlite-v1/${row.id}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return {
    id,
    title: row.title,
    content: row.text,
    isRead: row.is_read === 1,
    createdAt,
    updatedAt: createdAt,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const position = args.indexOf('--source');
  if (position < 0 || !args[position + 1])
    throw new Error('请用--source显式指定已备份的SQLite文件');
  const source = new DatabaseSync(resolve(args[position + 1]), { readOnly: true });
  let entries: Partial<XiaofeiyuDiaryEntry>[];
  try {
    const rows = source
      .prepare('SELECT id,title,text,created_at,is_read FROM entries ORDER BY id')
      .all();
    entries = rows.map((row) => convertLegacyEntry(row as unknown as LegacyDiaryRow));
  } finally {
    source.close();
  }
  if (!args.includes('--apply')) {
    console.log(`已只读校验${entries.length}条日记；未连接MySQL，也未写入任何日记。`);
    return;
  }
  await ConfigModule.forRoot({ envFilePath: ['.env.local', '.env'] });
  const connection = new DataSource({
    type: 'mysql',
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 3306),
    username: process.env.DB_USERNAME || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_DATABASE || 'tuanzi_server',
    entities: [XiaofeiyuDiaryEntry],
    synchronize: false,
    logging: false,
  });
  await connection.initialize();
  try {
    await connection.transaction(async (manager) => {
      for (let index = 0; index < entries.length; index += 100) {
        await manager
          .createQueryBuilder()
          .insert()
          .into(XiaofeiyuDiaryEntry)
          .values(entries.slice(index, index + 100))
          .orIgnore()
          .execute();
      }
    });
    console.log(`已处理${entries.length}条旧日记；已有相同迁移ID的记录保持原样。`);
  } finally {
    await connection.destroy();
  }
}

if (require.main === module) {
  main().catch(() => {
    // 不打印连接异常对象，避免凭据、宿主机路径或原始日记进入日志。
    console.error('日记迁移失败；请检查备份源、建表SQL和数据库连接配置，源SQLite保持只读。');
    process.exitCode = 1;
  });
}
