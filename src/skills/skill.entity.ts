import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  ManyToMany,
  JoinColumn,
  JoinTable,
  Index,
} from 'typeorm';
import { User } from '../users/users.entity';
import { McpServer } from '../mcp-servers/mcp-server.entity';
import type { SkillPackageFile, SkillSource } from './import/skill-package.types';

/**
 * Skill：当前 Agent 按需读取的工作流说明与可选资源包。
 * 不另起子 Agent，不改变宿主工具权限；旧工具配置字段仅保留数据兼容。
 */
@Entity('skills')
export class Skill {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** 技能标识（用于 $名称 和目录查找，snake_case），全局唯一 */
  @Index({ unique: true })
  @Column({ length: 100 })
  name: string;

  /** 工具描述：LLM 依此决定何时调用，直接影响调用质量 */
  @Column({ type: 'varchar', length: 500 })
  description: string;

  /** 技能正文（兼容旧列名；读取后作为工作流资料） */
  @Column({ name: 'system_prompt', type: 'text' })
  systemPrompt: string;

  @Column({ type: 'json', nullable: true })
  source?: SkillSource | null;

  @Column({ name: 'package_files', type: 'json', nullable: true, select: false })
  packageFiles?: SkillPackageFile[] | null;

  /** 入参 JSON Schema；为空时工具只接收单个 input 字符串 */
  @Column({ name: 'input_schema', type: 'json', nullable: true })
  inputSchema: Record<string, unknown> | null;

  /** 旧版工具配置，保留存储兼容，技能执行不读取 */
  @Column({ name: 'enabled_tools', type: 'json', nullable: true })
  enabledTools: string[] | null;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  /** 旧版 MCP 关联，保留存储兼容，技能执行不读取 */
  @ManyToMany(() => McpServer)
  @JoinTable({
    name: 'skill_mcp_servers',
    joinColumn: { name: 'skill_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'mcp_server_id', referencedColumnName: 'id' },
  })
  mcpServers: McpServer[];

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'created_by' })
  creator: User;

  @Column({ name: 'created_by' })
  createdBy: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}

/** API 响应形状：mcpServers 关系展开为 id 列表 */
export type SkillView = Omit<Skill, 'creator' | 'mcpServers' | 'packageFiles'> & {
  mcpServerIds: string[];
};
