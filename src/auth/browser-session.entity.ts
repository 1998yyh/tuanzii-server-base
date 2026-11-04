import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('auth_sessions')
export class BrowserSession {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Index({ unique: true })
  @Column({ name: 'token_hash', type: 'char', length: 64, select: false })
  tokenHash: string;
  @Index() @Column({ name: 'user_id', length: 36 }) userId: string;
  @Column({ name: 'auth_version', type: 'int', unsigned: true }) authVersion: number;
  @Column({ default: false }) remembered: boolean;
  @Column({ name: 'user_agent', length: 180 }) userAgent: string;
  @Column({ name: 'last_seen_at', type: 'datetime', precision: 3 }) lastSeenAt: Date;
  @Index() @Column({ name: 'expires_at', type: 'datetime', precision: 3 }) expiresAt: Date;
  @Column({ name: 'revoked_at', type: 'datetime', precision: 3, nullable: true })
  revokedAt: Date | null;
  @CreateDateColumn({ name: 'created_at', precision: 3 }) createdAt: Date;
  @UpdateDateColumn({ name: 'updated_at', precision: 3 }) updatedAt: Date;
}

@Entity('user_app_grants')
export class UserAppGrant {
  @PrimaryColumn({ name: 'user_id', length: 36 }) userId: string;
  @PrimaryColumn({ name: 'app_id', length: 32 }) appId: string;
  @CreateDateColumn({ name: 'created_at' }) createdAt: Date;
}
