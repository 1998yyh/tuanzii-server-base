import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('xiaofeiyu_diary_entries')
@Index('idx_xiaofeiyu_diary_created', ['createdAt', 'id'])
@Index('idx_xiaofeiyu_diary_unread', ['isRead', 'createdAt'])
export class XiaofeiyuDiaryEntry {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 300 })
  title: string;

  @Column({ type: 'mediumtext' })
  content: string;

  @Column({ name: 'is_read', default: false })
  isRead: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', precision: 6 })
  updatedAt: Date;
}
