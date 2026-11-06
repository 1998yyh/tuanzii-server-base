import { createHash } from 'node:crypto';
import { GithubSkillsService } from 'src/skills/import/github-skills.service';
import {
  parseGithubSource,
  parseSkillManifest,
  safePackagePath,
} from 'src/skills/import/skill-manifest';
import { SkillImportService } from 'src/skills/import/skill-import.service';
import { SkillToolFactory } from 'src/skills/skill-tool.factory';
import { UserRole } from 'src/users/users.entity';
import { Skill } from 'src/skills/skill.entity';
import { GithubSkillsService as Github } from 'src/skills/import/github-skills.service';
import { SkillsService } from 'src/skills/skills.service';
import type { SkillPackage } from 'src/skills/import/skill-package.types';
import { assertPublicUrl } from 'src/common/utils/ssrf.util';
jest.mock('src/common/utils/ssrf.util', () => ({
  assertPublicUrl: jest.fn(async (url: string) => new URL(url)),
}));
const manifest =
  '---\nname: sample-skill\ndescription: |\n  A reusable skill.\n  Use it to test imports.\nallowed-tools: Bash\n---\n# Instructions\nRead references/guide.md first.\n';
const file = (path: string, text: string) => {
  const bytes = Buffer.from(text);
  return {
    path,
    content: text,
    size: bytes.length,
    sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
    encoding: 'utf8' as const,
  };
};
const revision = 'a'.repeat(40),
  treeSha = 'b'.repeat(40);
const bundle: SkillPackage = {
  name: 'sample_skill',
  description: 'sample',
  systemPrompt: manifest,
  source: {
    kind: 'github',
    repository: 'owner/repo',
    ref: 'main',
    revision,
    manifestPath: 'skills/sample/SKILL.md',
    url: 'https://github.com/owner/repo',
    originalName: 'sample-skill',
    importedAt: '2026-11-05',
    fileCount: 2,
    totalBytes: 100,
  },
  files: [file('SKILL.md', manifest), file('references/guide.md', 'A useful guide.')],
};
describe('技能包格式与路径', () => {
  it('读取多行 YAML 描述，规范平台名并保留原始名，不从 allowed-tools 授权', () => {
    const result = parseSkillManifest(manifest);
    expect(result.name).toBe('sample_skill');
    expect(result.originalName).toBe('sample-skill');
    expect(result.description).toContain('Use it');
    expect(result).not.toHaveProperty('allowed-tools');
  });
  it.each([
    'plain content',
    '---\nname: sample\n---\nbody',
    '---\nname: x\nname: y\ndescription: d\n---\nbody',
    '---\nname: x\ndescription: &a [*a]\n---\nbody',
  ])('拒绝缺失、重复或别名元数据：%s', (text) => expect(() => parseSkillManifest(text)).toThrow());
  it.each([
    'https://evil.example/owner/repo',
    'http://github.com/owner/repo',
    'https://github.com@127.0.0.1/owner/repo',
    'https://github.com/owner/repo/tree/main/%2e%2e/secrets',
    'https://github.com/owner/repo/blob/main/a%2fb%5cc/SKILL.md',
  ])('拒绝非公开 GitHub 地址及危险路径：%s', (url) =>
    expect(() => parseGithubSource(url)).toThrow(),
  );
  it('支持 GitHub、raw、指定分支及 .github 技能目录', () => {
    expect(
      parseGithubSource('https://github.com/owner/repo/tree/feat/topic/skills/demo', 'feat/topic'),
    ).toMatchObject({ ref: 'feat/topic', path: 'skills/demo' });
    expect(
      parseGithubSource('https://raw.githubusercontent.com/owner/repo/main/skills/demo/SKILL.md'),
    ).toMatchObject({ ref: 'main', path: 'skills/demo/SKILL.md' });
    expect(safePackagePath('.github/skills/demo/SKILL.md')).toBe(true);
    expect(safePackagePath('../SKILL.md')).toBe(false);
    expect(safePackagePath('/etc/passwd')).toBe(false);
  });
});
describe('GitHub 技能下载', () => {
  let spy: jest.SpyInstance, service: GithubSkillsService;
  const original = [
    file('skills/sample/SKILL.md', manifest),
    file('skills/sample/references/guide.md', 'Read me.'),
    file('skills/other/SKILL.md', manifest),
  ];
  let entries: { path: string; type: string; mode: string; sha: string; size: number }[];
  let corrupt: boolean;
  beforeEach(() => {
    corrupt = false;
    service = new GithubSkillsService();
    entries = original.map((item) => ({
      path: item.path,
      type: 'blob',
      mode: '100644',
      sha: item.sha,
      size: item.size,
    }));
    spy = jest.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://api.github.com/repos/owner/repo')
        return Response.json({ default_branch: 'main', private: false });
      if (url.includes('/commits/'))
        return Response.json({ sha: revision, commit: { tree: { sha: treeSha } } });
      if (url.includes('/git/trees/')) return Response.json({ tree: entries, truncated: false });
      const item = original.find((file) => url.endsWith('/' + file.path));
      if (item) return new Response(corrupt ? 'corrupt' : item.content);
      throw new Error('Unexpected URL: ' + url);
    });
  });
  afterEach(() => spy.mockRestore());
  it('仓库根有多个技能时先返回候选，不下载无关文件', async () => {
    const result = await service.preview('u', 'https://github.com/owner/repo');
    expect(result.kind).toBe('choose');
    if (result.kind !== 'choose') return;
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].url).toContain(revision);
    expect(spy).toHaveBeenCalledTimes(3);
  });
  it('固定 commit 下载目录内全部文件，验证 Git blob 校验并保留来源', async () => {
    const result = await service.preview(
      'u',
      'https://github.com/owner/repo/tree/main/skills/sample',
    );
    expect(result.kind).toBe('preview');
    if (result.kind !== 'preview') return;
    expect(result.skill.files.map((item) => item.path)).toEqual([
      'SKILL.md',
      'references/guide.md',
    ]);
    expect(result.skill.source).toMatchObject({
      revision,
      repository: 'owner/repo',
      originalName: 'sample-skill',
      fileCount: 2,
    });
    expect(result.skill.name).toBe('sample_skill');
    expect(assertPublicUrl).toHaveBeenCalledWith(
      expect.stringContaining('https://raw.githubusercontent.com/owner/repo/' + revision),
    );
    expect(spy.mock.calls.every(([, init]) => init.redirect === 'error')).toBe(true);
  });
  it('拒绝内容被替换的文件', async () => {
    corrupt = true;
    await expect(
      service.preview('u', 'https://github.com/owner/repo/tree/main/skills/sample'),
    ).rejects.toThrow('校验');
  });
  it.each(['120000', '160000'])('不跟随符号链接或子模块 %s', async (mode) => {
    entries[0].mode = mode;
    await expect(
      service.preview('u', 'https://github.com/owner/repo/tree/main/skills/sample'),
    ).rejects.toThrow();
  });
  it('超过总大小或单文件预算时不下载正文', async () => {
    entries[0].size = 1_000_000;
    await expect(
      service.preview('u', 'https://github.com/owner/repo/tree/main/skills/sample'),
    ).rejects.toThrow('512 KB');
    expect(spy).toHaveBeenCalledTimes(3);
  });
  it('GitHub 限流明确报错，不伪装为空市场', async () => {
    spy.mockResolvedValue(new Response('', { status: 429 }));
    await expect(service.preview('u', 'https://github.com/owner/repo')).rejects.toThrow('次数受限');
  });
});
describe('确认导入与文件边界', () => {
  const admin = { id: 'admin', role: UserRole.ADMIN } as any;
  let service: SkillImportService, github: { preview: jest.Mock }, skills: { create: jest.Mock };
  beforeEach(() => {
    github = {
      preview: jest.fn(async () => ({ kind: 'preview', skill: structuredClone(bundle) })),
    };
    skills = { create: jest.fn(async () => ({ id: 'saved' })) };
    service = new SkillImportService(
      github as unknown as Github,
      skills as unknown as SkillsService,
    );
  });
  it('预览绑定管理员、确认时保存同一快照且不获取移动分支', async () => {
    const result = await service.preview(admin, { url: 'https://github.com/owner/repo' });
    if (result.kind !== 'preview') throw Error();
    await expect(
      service.import(
        { ...admin, id: 'other' },
        { previewId: result.previewId, name: 'custom', description: 'custom' },
      ),
    ).rejects.toThrow('不可访问');
    await service.import(admin, {
      previewId: result.previewId,
      name: 'custom',
      description: 'custom',
    });
    expect(github.preview).toHaveBeenCalledTimes(1);
    expect(skills.create).toHaveBeenCalledWith(
      admin,
      { name: 'custom', description: 'custom', systemPrompt: manifest },
      { source: bundle.source, files: bundle.files },
    );
    expect(
      await service.import(admin, {
        previewId: result.previewId,
        name: 'custom',
        description: 'custom',
      }),
    ).toEqual({ id: 'saved' });
    expect(skills.create).toHaveBeenCalledTimes(1);
  });
  it('普通账号不能触发仓库读取', async () => {
    await expect(
      service.preview({ ...admin, role: UserRole.USER }, { url: 'https://github.com/owner/repo' }),
    ).rejects.toThrow('管理员');
    expect(github.preview).not.toHaveBeenCalled();
  });
  it('重名失败后保留预览，允许改名重试', async () => {
    const result = await service.preview(admin, { url: 'https://github.com/owner/repo' });
    if (result.kind !== 'preview') throw Error();
    skills.create.mockRejectedValueOnce(new Error('名称已存在'));
    await expect(
      service.import(admin, { previewId: result.previewId, name: 'taken', description: 'd' }),
    ).rejects.toThrow('已存在');
    await service.import(admin, {
      previewId: result.previewId,
      name: 'new_name',
      description: 'd',
    });
    expect(skills.create).toHaveBeenCalledTimes(2);
  });
  it('过期的预览不能安装', async () => {
    const result = await service.preview(admin, { url: 'https://github.com/owner/repo' });
    if (result.kind !== 'preview') throw Error();
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 601000);
    try {
      await expect(
        service.import(admin, { previewId: result.previewId, name: 'n', description: 'd' }),
      ).rejects.toThrow('过期');
    } finally {
      now.mockRestore();
    }
  });
  it('文件读取只访问包内相对路径，分页读取不访问宿主文件系统', async () => {
    const factory = new SkillToolFactory({
      findByAgentConfig: async () => [
        {
          name: 'sample',
          description: 'sample description',
          systemPrompt: 'sample instructions',
          isActive: true,
          packageFiles: bundle.files,
        } as Skill,
      ],
    } as any);
    const reader = (await factory.createToolsForAgent({ id: 'agent-1' } as any)).find(
      (tool) => tool.name === 'skills_read_file',
    )!;
    expect(await reader.invoke({ name: 'sample', path: '/etc/passwd' })).toContain('不合法');
    expect(await reader.invoke({ name: 'sample', path: '../SKILL.md' })).toContain('不合法');
    expect(
      JSON.parse(
        (await reader.invoke({ name: 'sample', path: 'references/guide.md', limit: 5 })) as string,
      ),
    ).toMatchObject({ content: 'A use', nextOffset: 5 });
  });
});
