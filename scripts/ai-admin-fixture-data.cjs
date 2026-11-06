// 只供本机隔离联调：使用真实控制器、会话与 DTO，数据/模型执行替换为内存夹具。
module.exports = function aiFixture(root) {
  const { randomUUID } = require('node:crypto');
  const { BadRequestException, NotFoundException } = require('@nestjs/common');
  const { AgentsController } = require(root + '/agents/agents.controller.js');
  const { AgentsService } = require(root + '/agents/agents.service.js');
  const { ConversationsController } = require(root + '/agents/conversations.controller.js');
  const { ConversationsService } = require(root + '/agents/conversations.service.js');
  const { AiChannelsController } = require(root + '/ai-generation/ai-channels.controller.js');
  const { AiChannelsService } = require(root + '/ai-generation/ai-channels.service.js');
  const { SkillsController } = require(root + '/skills/skills.controller.js');
  const { SkillsService } = require(root + '/skills/skills.service.js');
  const { SkillImportController } = require(root + '/skills/import/skill-import.controller.js');
  const { SkillImportService } = require(root + '/skills/import/skill-import.service.js');
  const { GithubSkillsService } = require(root + '/skills/import/github-skills.service.js');
  const { parseGithubSource } = require(root + '/skills/import/skill-manifest.js');
  const { McpServersController } = require(root + '/mcp-servers/mcp-servers.controller.js');
  const { McpServersService } = require(root + '/mcp-servers/mcp-servers.service.js');
  const channels = [], agents = [], skills = [], servers = [];
  const associations = new Map(), conversations = new Map();
  const metadata = name => ({ id: randomUUID(), name, isActive: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const fields = (value, names) => Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, value[name]]));
  const find = (items, id) => { const item = items.find(value => value.id === id); if (!item) throw new NotFoundException('资源不存在'); return item; };
  const owned = (items, userId, id) => { const item = find(items, id); if (item.userId !== userId) throw new NotFoundException('资源不存在'); return item; };
  const paged = (items, query = {}) => { const page = query.page ?? 1, limit = query.limit ?? 10; return { items: items.slice((page - 1) * limit, page * limit), total: items.length, page, limit, totalPages: Math.ceil(items.length / limit) }; };
  const shared = (items, payloadFields) => ({
    findAllActive: async (...args) => { const includeInactive = args.at(-1) === true; const selected = items.filter(item => includeInactive || item.isActive); return { items: selected, total: selected.length }; },
    create: async (user, data) => { const item = { ...metadata(data.name), description: null, createdBy: user.id, ...fields(data, payloadFields) }; items.push(item); return item; },
    update: async (_user, id, data) => { const item = find(items, id); Object.assign(item, fields(data, [...payloadFields, 'isActive']), { updatedAt: new Date().toISOString() }); return item; },
    remove: async (_user, id) => { const index = items.findIndex(item => item.id === id); if (index < 0) throw new NotFoundException('资源不存在'); items.splice(index, 1); },
  });
  const channelFields = ['name', 'baseUrl', 'apiFormat', 'models', 'isActive'];
  const channelService = {
    findAll: async user => channels.filter(item => item.userId === user.id),
    getPresets: () => ({ presets: [], templates: [] }),
    create: async (user, data) => { const item = { ...metadata(data.name), ...fields(data, channelFields), userId: user.id, apiKeyMasked: 'sk-****test' }; channels.push(item); return item; },
    update: async (user, id, data) => { const item = owned(channels, user.id, id); Object.assign(item, fields(data, channelFields), { updatedAt: new Date().toISOString() }); return item; },
    remove: async (user, id) => { owned(channels, user.id, id); if (agents.some(agent => agent.channelId === id && agent.isActive)) throw new BadRequestException('渠道仍被 Agent 引用'); channels.splice(channels.findIndex(item => item.id === id), 1); },
  };
  const agentFields = ['name', 'description', 'channelId', 'modelName', 'systemPrompt', 'maxTokens', 'maxIterations', 'enabledTools', 'isActive'];
  const attachChannel = item => ({ ...item, channelName: channels.find(channel => channel.id === item.channelId)?.name ?? null, apiFormat: channels.find(channel => channel.id === item.channelId)?.apiFormat ?? null });
  const association = (userId, id, key) => { owned(agents, userId, id); const value = associations.get(id) ?? { skills: [], servers: [] }; return { value, selected: (key === 'skills' ? skills : servers).filter(item => value[key].includes(item.id)) }; };
  const agentService = {
    findAll: async (userId, query, includeInactive = false) => paged(agents.filter(item => item.userId === userId && (includeInactive || item.isActive)).map(attachChannel), query),
    findOne: async (userId, id) => attachChannel(owned(agents, userId, id)),
    create: async (user, data) => { owned(channels, user.id, data.channelId); const item = { ...metadata(data.name), description: null, systemPrompt: null, maxTokens: 4096, maxIterations: 10, enabledTools: [], ...fields(data, agentFields), userId: user.id }; agents.push(item); return attachChannel(item); },
    update: async (user, id, data) => { const item = owned(agents, user.id, id); if (data.channelId) owned(channels, user.id, data.channelId); Object.assign(item, fields(data, agentFields), { updatedAt: new Date().toISOString() }); return attachChannel(item); },
    remove: async (userId, id) => { owned(agents, userId, id).isActive = false; },
    getSkills: async (userId, id) => association(userId, id, 'skills').selected,
    getMcpServers: async (userId, id) => association(userId, id, 'servers').selected,
    updateSkills: async (user, id, ids) => { const { value } = association(user.id, id, 'skills'); ids.forEach(id => find(skills, id)); value.skills = ids; associations.set(id, value); return association(user.id, id, 'skills').selected; },
    updateMcpServers: async (user, id, ids) => { const { value } = association(user.id, id, 'servers'); ids.forEach(id => find(servers, id)); value.servers = ids; associations.set(id, value); return association(user.id, id, 'servers').selected; },
  };
  const conversation = (userId, id) => { const value = conversations.get(id); if (!value) throw new NotFoundException('会话不存在'); owned(agents, userId, value.agentConfigId); return value; };
  const { setTimeout: delay } = require('node:timers/promises');
  const executing = new Set();
  const conversationService = {
    createConversation: async (userId, agentId, data) => { owned(agents, userId, agentId); const item = { id: randomUUID(), agentConfigId: agentId, title: data.title, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), messages: [] }; if (data.title === '[fixture-history]') item.messages = Array.from({ length: 70 }, (_, i) => ({ id: randomUUID(), role: i % 2 ? 'assistant' : 'user', content: `历史消息 ${i + 1}`, createdAt: new Date().toISOString() })); conversations.set(item.id, item); return { id: item.id }; },
    listConversations: async (userId, agentId, query) => { owned(agents, userId, agentId); return paged([...conversations.values()].filter(item => item.agentConfigId === agentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(({ messages, ...item }) => item), query); },
    prepareStream: async (userId, id) => { const item = conversation(userId, id); if (!owned(agents, userId, item.agentConfigId).isActive) throw new BadRequestException('Agent 已停用'); return { ...item, agentConfig: owned(agents, userId, item.agentConfigId) }; },
    async *streamMessages(item, content, { signal }) {
      if (executing.has(item.id)) throw new BadRequestException('会话正在执行');
      executing.add(item.id);
      try {
        const tool = { id: randomUUID(), name: 'fixture_search', args: { query: content } };
        const delegated = { id: randomUUID(), name: 'delegate_task', args: { task: '验证计算结果' } };
        const event = (type, data) => ({ type, data });
        yield event('message_start', {});
        yield event('reasoning_delta', { text: '隔离测试：检查可用工具并验证结果。' });
        yield event('text_delta', { text: '我会先查询资料，再核对结果。' });
        yield event('message_end', { content: '我会先查询资料，再核对结果。', toolCalls: [tool], totalTokens: 10 });
        yield event('tool_use', tool);
        await delay(content.includes('slow') ? 5000 : 350, undefined, { signal });
        if (content.includes('stream-error')) { yield event('error', { code: 'TEST_ERROR', message: '隔离测试：上游服务暂时不可用' }); return; }
        yield event('tool_result', { callId: tool.id, name: tool.name, content: '找到 2 条隔离测试资料。', isError: content.includes('tool-error') });
        yield event('tool_use', delegated);
        yield event('sub_event', { callId: delegated.id, type: 'message_start', data: {} });
        yield event('sub_event', { callId: delegated.id, type: 'tool_use', data: { id: 'nested-calculator', name: 'calculator', args: { expression: '1 + 1' } } });
        await delay(350, undefined, { signal });
        yield event('sub_event', { callId: delegated.id, type: 'tool_result', data: { callId: 'nested-calculator', name: 'calculator', content: '2' } });
        yield event('sub_event', { callId: delegated.id, type: 'message_end', data: { content: '计算结果已核对：2。', totalTokens: 5 } });
        yield event('tool_result', { callId: delegated.id, name: delegated.name, content: '子任务核对成功。' });
        yield event('message_start', {});
        const answer = '真实会话与 DTO 联调成功（模型为隔离替身）。\n\n```typescript title=example.ts\nconst result = 1 + 1\nconsole.log(result)\n```';
        for (const text of [answer.slice(0, 12), answer.slice(12)]) { yield event('text_delta', { text }); await delay(150, undefined, { signal }); }
        yield event('message_end', { content: answer, conversationId: item.id, totalTokens: 125 });
        signal.throwIfAborted();
        const stored = conversations.get(item.id);
        stored.messages.push(
          { id: randomUUID(), role: 'user', content },
          { id: randomUUID(), role: 'assistant', content: '我会先查询资料，再核对结果。', reasoning: '隔离测试：检查可用工具并验证结果。', toolCalls: [tool, delegated] },
          { id: randomUUID(), role: 'tool', toolCallId: tool.id, content: '找到 2 条隔离测试资料。', isError: content.includes('tool-error') },
          { id: randomUUID(), role: 'tool', toolCallId: delegated.id, content: '子任务核对成功。' },
          { id: randomUUID(), role: 'assistant', content: answer, totalTokens: 125 },
        );
        stored.updatedAt = new Date().toISOString();
      } finally { executing.delete(item.id); }
    },
    sendMessage: async (userId, id, data) => { const item = conversation(userId, id); item.messages.push({ id: randomUUID(), role: 'user', content: data, createdAt: new Date().toISOString() }, { id: randomUUID(), role: 'assistant', content: '真实会话与 DTO 联调成功（模型为隔离替身）。', toolCalls: null, createdAt: new Date().toISOString() }); return {}; },
    removeConversation: async (userId, id) => { conversation(userId, id); conversations.delete(id); },
    listMessages: async (userId, id, query) => paged([...conversation(userId, id).messages].reverse(), query),
  };
  const skillService = shared(skills, ['name', 'description', 'systemPrompt', 'enabledTools', 'mcpServerIds', 'inputSchema']);
  const originalCreateSkill = skillService.create;
  const originalSkillList = skillService.findAllActive;
  skillService.findAllActive = async (...args) => { const result = await originalSkillList(...args); return { ...result, items: result.items.map(({ packageFiles, ...item }) => item) }; };
  skillService.create = async (user, data, bundle) => {
    if (skills.some(item => item.name === data.name)) throw new (require('@nestjs/common').ConflictException)('技能名称已存在');
    const item = await originalCreateSkill(user, { enabledTools: [], mcpServerIds: [], inputSchema: null, ...data });
    item.source = bundle?.source ?? null;
    item.packageFiles = bundle?.files ?? [];
    const { packageFiles, ...view } = item;
    return view;
  };
  skillService.package = async id => { const item = find(skills, id); return { source: item.source ?? null, files: item.packageFiles ?? [] }; };
  const importedManifest = '---\nname: fixture-skill\ndescription: Fixture skill import description\n---\n# Imported skill\nRead references/guide.md before working.\n';
  const githubFixture = {
    preview: async (_user, url, ref) => {
      const parsed = parseGithubSource(url, ref);
      if (url.includes('bad-manifest')) throw new BadRequestException('SKILL.md 元数据不合法');
      if (!parsed.path) return { kind: 'choose', repository: parsed.repository, revision: 'a'.repeat(40), candidates: [{ path: 'skills/example/SKILL.md', url: `https://github.com/${parsed.repository}/blob/${'a'.repeat(40)}/skills/example/SKILL.md` }] };
      return { kind: 'preview', skill: {
        name: 'fixture_skill', description: 'Fixture skill import description', systemPrompt: importedManifest,
        source: { kind: 'github', repository: parsed.repository, ref: ref || 'main', revision: 'a'.repeat(40), manifestPath: 'skills/example/SKILL.md', url, originalName: 'fixture-skill', importedAt: new Date().toISOString(), fileCount: 2, totalBytes: 180 },
        files: [{ path: 'SKILL.md', encoding: 'utf8', content: importedManifest, size: 150, sha: 'a'.repeat(40) }, { path: 'references/guide.md', encoding: 'utf8', content: 'This is a packaged reference file.', size: 30, sha: 'b'.repeat(40) }],
      } };
    },
  };
  const serverService = shared(servers, ['name', 'description', 'type', 'command', 'args', 'url']);
  return {
    controllers: [AgentsController, AiChannelsController, SkillsController, SkillImportController, McpServersController, ConversationsController],
    providers: [
      { provide: AgentsService, useValue: agentService },
      { provide: AiChannelsService, useValue: channelService },
      { provide: SkillsService, useValue: skillService },
      { provide: GithubSkillsService, useValue: githubFixture },
      SkillImportService,
      { provide: McpServersService, useValue: serverService },
      { provide: ConversationsService, useValue: conversationService },
    ],
  };
};
