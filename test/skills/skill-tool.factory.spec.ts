import { SkillToolFactory } from 'src/skills/skill-tool.factory';
import { SkillsService } from 'src/skills/skills.service';
import { Skill } from 'src/skills/skill.entity';
import { AgentConfig } from 'src/agents/entities/agent-config.entity';

const buildSkill = (override: Partial<Skill> = {}): Skill =>
  ({
    id: 'skill-1',
    name: 'report',
    description: '生成日报',
    systemPrompt: '先核对来源再编写日报',
    enabledTools: ['web_search'],
    mcpServers: [{ id: 'legacy-mcp' }],
    isActive: true,
    ...override,
  }) as Skill;
const file = (path: string, content: string) => ({
  path,
  content,
  encoding: 'utf8' as const,
  size: content.length,
  sha: 'sha',
});
describe('SkillToolFactory：在当前 Agent 中按需读取', () => {
  let service: { findByAgentConfig: jest.Mock };
  let factory: SkillToolFactory;
  const config = { id: 'agent-1' } as AgentConfig;
  beforeEach(() => {
    service = { findByAgentConfig: jest.fn().mockResolvedValue([buildSkill()]) };
    factory = new SkillToolFactory(service as unknown as SkillsService);
  });
  const load = async () =>
    Object.fromEntries(
      (await factory.createToolsForAgent(config)).map((tool) => [tool.name, tool]),
    );

  it('初始只公开元数据，不把正文写进工具描述，不创建同名子 Agent 工具', async () => {
    const tools = await load();
    expect(service.findByAgentConfig).toHaveBeenCalledWith('agent-1');
    expect(Object.keys(tools)).toEqual(['skills_list', 'skills_read', 'skills_read_file']);
    expect(tools.skills_list.description).toContain('生成日报');
    expect(
      Object.values(tools)
        .map((tool) => tool.description)
        .join(''),
    ).not.toContain('先核对来源');
    expect(JSON.parse(await tools.skills_list.invoke({}))).toEqual({
      items: [
        {
          name: 'report',
          description: '生成日报',
          path: 'skills/report/SKILL.md',
          allowImplicitInvocation: true,
        },
      ],
      nextOffset: null,
    });
  });
  it('显式 $名称 可读取完整正文，结果交给当前 Agent，旧工具配置不授予权限', async () => {
    const tools = await load();
    const result = JSON.parse(await tools.skills_read.invoke({ name: '$report' }));
    expect(result.content).toBe('先核对来源再编写日报');
    expect(result.instructions).toContain('当前会话');
    expect(JSON.stringify(result)).not.toContain('legacy-mcp');
    expect(JSON.stringify(result)).not.toContain('web_search');
  });
  it('只能读已关联启用的技能，未知与停用不暴露正文', async () => {
    service.findByAgentConfig.mockResolvedValue([
      buildSkill(),
      buildSkill({ name: 'disabled', isActive: false, systemPrompt: 'hidden' }),
    ]);
    const tools = await load();
    expect(await tools.skills_read.invoke({ name: 'disabled' })).toContain('未关联');
    expect(await tools.skills_read_file.invoke({ name: 'other', path: 'SKILL.md' })).toContain(
      '未关联',
    );
    expect(JSON.stringify(await tools.skills_list.invoke({}))).not.toContain('disabled');
  });
  it('无技能不注入工具；技能名与内置工具同名也只是目录名', async () => {
    service.findByAgentConfig.mockResolvedValue([]);
    expect(await factory.createToolsForAgent(config)).toEqual([]);
    service.findByAgentConfig.mockResolvedValue([buildSkill({ name: 'web_search' })]);
    expect(Object.keys(await load())).not.toContain('web_search');
  });
  it('引用文件按需分段读取，不提前放进模型描述', async () => {
    service.findByAgentConfig.mockResolvedValue([
      buildSkill({ packageFiles: [file('references/a.md', 'abcdef')] }),
    ]);
    const tools = await load();
    expect(JSON.parse(await tools.skills_read.invoke({ name: 'report' })).files).toEqual([
      { path: 'references/a.md', encoding: 'utf8', size: 6 },
    ]);
    expect(
      JSON.parse(
        await tools.skills_read_file.invoke({
          name: 'report',
          path: 'references/a.md',
          offset: 2,
          limit: 2,
        }),
      ),
    ).toEqual({ path: 'references/a.md', content: 'cd', nextOffset: 4 });
    expect(
      JSON.parse(
        await tools.skills_read_file.invoke({
          name: 'report',
          path: 'references/a.md',
          offset: 4,
          limit: 5,
        }),
      ).nextOffset,
    ).toBeNull();
    expect(
      JSON.parse(await tools.skills_read_file.invoke({ name: 'report', path: 'SKILL.md' })).content,
    ).toContain('先核对来源');
  });
  it('拒绝越界、绝对路径、包外文件与二进制文本读取', async () => {
    service.findByAgentConfig.mockResolvedValue([
      buildSkill({ packageFiles: [{ ...file('assets/a.png', 'AAAA'), encoding: 'base64' }] }),
    ]);
    const tools = await load();
    for (const path of ['../other/SKILL.md', '/etc/passwd', 'a/../b', 'a\\b'])
      expect(await tools.skills_read_file.invoke({ name: 'report', path })).toContain('不合法');
    expect(await tools.skills_read_file.invoke({ name: 'report', path: 'missing' })).toContain(
      '不存在',
    );
    expect(await tools.skills_read_file.invoke({ name: 'report', path: 'assets/a.png' })).toContain(
      '二进制',
    );
  });
  it('技能列表搜索与分页，目录过大提示继续发现且不塞入正文', async () => {
    service.findByAgentConfig.mockResolvedValue(
      Array.from({ length: 100 }, (_, i) =>
        buildSkill({ name: `report_${i}`, description: 'x'.repeat(500) }),
      ),
    );
    const tools = await load();
    expect(tools.skills_list.description).toContain('分页');
    const result = JSON.parse(
      await tools.skills_list.invoke({ query: 'report_9', offset: 1, limit: 2 }),
    );
    expect(result.items.map((item: { name: string }) => item.name)).toEqual([
      'report_90',
      'report_91',
    ]);
    expect(result.nextOffset).toBe(3);
  });
  it('保留 openai.yaml 的显式调用策略，配置异常时关闭隐式选择', async () => {
    for (const content of ['policy:\n  allow_implicit_invocation: false', 'policy: *alias']) {
      service.findByAgentConfig.mockResolvedValue([
        buildSkill({ packageFiles: [file('agents/openai.yaml', content)] }),
      ]);
      const tools = await load();
      expect(JSON.parse(await tools.skills_list.invoke({})).items[0].allowImplicitInvocation).toBe(
        false,
      );
      expect(JSON.parse(await tools.skills_read.invoke({ name: '$report' })).content).toContain(
        '先核对来源',
      );
    }
  });
});
