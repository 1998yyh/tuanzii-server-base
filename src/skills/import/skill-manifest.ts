import { BadRequestException } from '@nestjs/common';
import { parseDocument } from 'yaml';

export function parseSkillManifest(content: string) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content);
  if (!match || match[1].length > 16384)
    throw new BadRequestException('SKILL.md 必须包含有效的 YAML 元数据');
  try {
    const document = parseDocument(match[1], { uniqueKeys: true, schema: 'core' });
    if (document.errors.length) throw new Error('YAML');
    const data: unknown = document.toJS({ maxAliasCount: 0 });
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('YAML');
    const fields = data as Record<string, unknown>;
    if (typeof fields.name !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(fields.name))
      throw new Error('name');
    if (
      typeof fields.description !== 'string' ||
      !fields.description.trim() ||
      fields.description.length > 8192
    )
      throw new Error('description');
    if (!match[2].trim()) throw new Error('body');
    // 平台现有工具名使用 snake_case，保留原始技能名在来源元数据中。
    let name = fields.name.replace(/-/g, '_');
    if (!/^[a-z]/.test(name)) name = `skill_${name}`;
    return {
      originalName: fields.name,
      name: name.slice(0, 100),
      description: fields.description.trim(),
      license: typeof fields.license === 'string' ? fields.license.slice(0, 500) : undefined,
      compatibility:
        typeof fields.compatibility === 'string' ? fields.compatibility.slice(0, 500) : undefined,
    };
  } catch {
    throw new BadRequestException(
      'SKILL.md 元数据不合法，需要 name、description 和正文；不支持 YAML 别名',
    );
  }
}

export function safePackagePath(path: string): boolean {
  return (
    !!path &&
    path.length <= 500 &&
    !path.startsWith('/') &&
    !path.includes('\\') &&
    ![...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    path
      .split('/')
      .every((part) => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
  );
}

export function parseGithubSource(raw: string, suppliedRef?: string) {
  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\\') || /(?:^|\/)\.{1,2}(?:\/|[?#]|$)/.test(decoded)) throw new Error();
  } catch {
    throw new BadRequestException('GitHub 路径不合法');
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestException('请填写有效的 GitHub 仓库或 SKILL.md 链接');
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    !['github.com', 'raw.githubusercontent.com'].includes(url.hostname)
  )
    throw new BadRequestException('仅支持公开 GitHub 仓库的 HTTPS 链接');
  const parts = url.pathname
    .split('/')
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new BadRequestException('GitHub 路径编码不合法');
      }
    });
  const owner = parts[0] ?? '',
    repo = (parts[1] ?? '').replace(/\.git$/, '');
  if (
    !/^[A-Za-z0-9_-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  )
    throw new BadRequestException('GitHub 仓库地址不合法');
  let ref = suppliedRef?.trim() || '',
    path = '';
  if (url.hostname === 'raw.githubusercontent.com' || ['tree', 'blob'].includes(parts[2])) {
    const rest = parts.slice(url.hostname === 'raw.githubusercontent.com' ? 2 : 3);
    if (!rest.length) throw new BadRequestException('GitHub 链接缺少版本');
    const refParts = ref ? ref.split('/') : [rest[0]];
    if (ref && refParts.some((part, index) => rest[index] !== part))
      throw new BadRequestException('填写的版本与 GitHub 链接不一致，请改用仓库主页链接');
    ref ||= rest[0];
    path = rest.slice(refParts.length).join('/');
  } else if (parts.length > 2)
    throw new BadRequestException('请使用仓库主页、tree 目录或 SKILL.md 文件链接');
  if (
    ref.length > 200 ||
    [...ref].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127) ||
    (path && !safePackagePath(path))
  )
    throw new BadRequestException('GitHub 版本或路径不合法');
  return { repository: `${owner}/${repo}`, owner, repo, ref, path };
}
