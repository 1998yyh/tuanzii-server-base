import { ForbiddenException } from '@nestjs/common';
import { AgentsController } from 'src/agents/agents.controller';
import { AgentsService } from 'src/agents/agents.service';
import { SkillsController } from 'src/skills/skills.controller';
import { SkillsService } from 'src/skills/skills.service';
import { McpServersController } from 'src/mcp-servers/mcp-servers.controller';
import { McpServersService } from 'src/mcp-servers/mcp-servers.service';
import { User, UserRole } from 'src/users/users.entity';

describe('AI 管理列表权限与资源范围', () => {
  const admin = { id: 'owner-admin', role: UserRole.ADMIN } as Omit<User, 'password'>;
  const ordinary = { id: 'ordinary', role: UserRole.USER } as Omit<User, 'password'>;
  it('普通账号无法绕过前端访问管理列表', async () => {
    const list = jest.fn();
    await expect(
      new AgentsController({ findAll: list } as unknown as AgentsService).management(ordinary, {}),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new SkillsController({ findAllActive: list } as unknown as SkillsService).management(
        ordinary,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new McpServersController({ findAllActive: list } as unknown as McpServersService).management(
        ordinary,
        {},
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(list).not.toHaveBeenCalled();
  });
  it('管理员 Agent 列表仍限制到当前账号并保留分页', async () => {
    const findAll = jest.fn().mockResolvedValue({ items: [], total: 0 });
    await new AgentsController({ findAll } as unknown as AgentsService).management(admin, {
      page: 2,
      limit: 100,
    });
    expect(findAll).toHaveBeenCalledWith('owner-admin', { page: 2, limit: 100 }, true);
  });
  it('管理员请求全状态资源，普通列表默认行为保持不变', async () => {
    const findAllActive = jest.fn().mockResolvedValue({ items: [], total: 0 });
    const skills = new SkillsController({ findAllActive } as unknown as SkillsService);
    await skills.management(admin);
    expect(findAllActive).toHaveBeenLastCalledWith(true);
    await skills.findAll();
    expect(findAllActive).toHaveBeenLastCalledWith();
    const servers = new McpServersController({ findAllActive } as unknown as McpServersService);
    await servers.management(admin, {});
    expect(findAllActive).toHaveBeenLastCalledWith({}, true);
    await servers.findAll({});
    expect(findAllActive).toHaveBeenLastCalledWith({});
  });

  it('读取停用 Agent 时仍携带账号过滤，普通查询保持启用过滤', async () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const context = {
      agentRepo: { findAndCount },
      loadChannelMap: jest.fn().mockResolvedValue(new Map()),
    } as unknown as AgentsService;
    await AgentsService.prototype.findAll.call(
      context,
      'owner-admin',
      { page: 2, limit: 100 },
      true,
    );
    expect(findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'owner-admin' }, skip: 100, take: 100 }),
    );
    await AgentsService.prototype.findAll.call(context, 'ordinary', {});
    expect(findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { userId: 'ordinary', isActive: true } }),
    );
  });

  it('共享资源管理查询包含停用项，普通查询只返回启用项', async () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const skills = {
      skillRepo: { findAndCount },
      loadMcpServerIdsBySkill: jest.fn().mockResolvedValue(new Map()),
    } as unknown as SkillsService;
    await SkillsService.prototype.findAllActive.call(skills, true);
    expect(findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({ where: {} }));
    await SkillsService.prototype.findAllActive.call(skills);
    expect(findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    const servers = { mcpServerRepo: { findAndCount } } as unknown as McpServersService;
    await McpServersService.prototype.findAllActive.call(servers, {}, true);
    expect(findAndCount).toHaveBeenLastCalledWith(expect.objectContaining({ where: {} }));
    await McpServersService.prototype.findAllActive.call(servers, {});
    expect(findAndCount).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
  });
});
