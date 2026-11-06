import { BadRequestException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { assertPublicUrl } from '../../common/utils/ssrf.util';
import { parseGithubSource, parseSkillManifest, safePackagePath } from './skill-manifest';
import type { SkillPackage, SkillPackageFile } from './skill-package.types';
interface TreeEntry {
  path: string;
  type: string;
  mode: string;
  sha: string;
  size?: number;
}
const MAX_FILES = 160,
  MAX_FILE = 512 * 1024,
  MAX_TOTAL = 4 * 1024 * 1024;
@Injectable()
export class GithubSkillsService {
  private readonly cache = new Map<string, { until: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Set<string>();
  private async request<T>(path: string, signal: AbortSignal, max = 5 * 1024 * 1024): Promise<T> {
    const cached = this.cache.get(path);
    if (cached && cached.until > Date.now()) return cached.value as T;
    if (this.pending.has(path)) return this.pending.get(path) as Promise<T>;
    const job = (async () => {
      const bytes = await this.bytes(
        `https://api.github.com${path}`,
        signal,
        max,
        'application/vnd.github+json',
      );
      let value: T;
      try {
        value = JSON.parse(bytes.toString('utf8')) as T;
      } catch {
        throw new BadRequestException('GitHub 返回数据格式不正确');
      }
      // 每个响应有大小上限，缓存总量受项数限制；预览中的技能包不存入全局缓存。
      if (bytes.length < 256 * 1024) {
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(path, { until: Date.now() + 300_000, value });
      }
      return value;
    })();
    this.pending.set(path, job);
    try {
      return await job;
    } finally {
      this.pending.delete(path);
    }
  }
  private async bytes(url: string, signal: AbortSignal, max: number, accept: string) {
    await assertPublicUrl(url);
    const response = await fetch(url, {
      signal,
      redirect: 'error',
      headers: {
        Accept: accept,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Tuanzi-Skill-Importer',
      },
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 404)
        throw new BadRequestException('仓库、版本或技能路径不存在；仅支持公开仓库');
      if ([403, 429].includes(response.status))
        throw new BadRequestException('GitHub 请求次数受限，请稍后重试');
      throw new BadRequestException('GitHub 暂时无法访问，请稍后重试');
    }
    const reader = response.body?.getReader();
    if (!reader) throw new BadRequestException('GitHub 返回内容为空');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) throw new BadRequestException('下载内容过大，请选择更小的技能包');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    return Buffer.concat(chunks);
  }
  async preview(userId: string, rawUrl: string, ref?: string, signal?: AbortSignal) {
    if (this.inFlight.has(userId) || this.inFlight.size >= 4)
      throw new BadRequestException('已有技能解析进行中，请稍后重试');
    this.inFlight.add(userId);
    try {
      return await this.load(rawUrl, ref, signal);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('无法读取 GitHub 技能，请检查链接或稍后重试');
    } finally {
      this.inFlight.delete(userId);
    }
  }
  private async load(rawUrl: string, ref?: string, parentSignal?: AbortSignal) {
    const source = parseGithubSource(rawUrl, ref),
      signal = parentSignal
        ? AbortSignal.any([parentSignal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000);
    const repoPath = `/repos/${source.repository}`;
    const repo = await this.request<{ default_branch: string; private: boolean }>(repoPath, signal);
    if (repo.private) throw new BadRequestException('仅支持公开仓库');
    const version = source.ref || repo.default_branch;
    const commit = await this.request<{ sha: string; commit: { tree: { sha: string } } }>(
      `${repoPath}/commits/${encodeURIComponent(version)}`,
      signal,
    );
    if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new BadRequestException('GitHub 提交版本无效');
    const tree = await this.request<{ tree: TreeEntry[]; truncated: boolean }>(
      `${repoPath}/git/trees/${commit.commit.tree.sha}?recursive=1`,
      signal,
    );
    if (tree.truncated || !Array.isArray(tree.tree))
      throw new BadRequestException('仓库目录过大，暂不能完整解析，请改用较小的技能仓库');
    const prefix =
      source.path.endsWith('/SKILL.md') || source.path === 'SKILL.md'
        ? source.path
        : source.path
          ? `${source.path}/`
          : '';
    const manifests = tree.tree.filter(
      (item) =>
        item.type === 'blob' &&
        (item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md')) &&
        (!prefix || item.path === prefix || item.path.startsWith(prefix)),
    );
    const direct = manifests.find(
      (item) =>
        item.path === source.path ||
        item.path === `${source.path ? source.path + '/' : ''}SKILL.md`,
    );
    const chosen = direct ?? (manifests.length === 1 ? manifests[0] : undefined);
    const manifestUrl = (path: string) =>
      `https://github.com/${source.repository}/blob/${commit.sha}/${path.split('/').map(encodeURIComponent).join('/')}`;
    if (!chosen) {
      if (!manifests.length) throw new BadRequestException('指定位置没有找到 SKILL.md');
      if (manifests.length > 100)
        throw new BadRequestException('仓库中技能过多，请填写具体技能目录链接');
      return {
        kind: 'choose' as const,
        repository: source.repository,
        revision: commit.sha,
        candidates: manifests.map((item) => ({ path: item.path, url: manifestUrl(item.path) })),
      };
    }
    const directory = chosen.path.slice(0, -'SKILL.md'.length);
    const nested = manifests
      .filter((item) => item.path !== chosen.path && item.path.startsWith(directory))
      .map((item) => item.path.slice(0, -'SKILL.md'.length));
    const files = tree.tree.filter(
      (item) =>
        item.type !== 'tree' &&
        item.path.startsWith(directory) &&
        !nested.some((path) => item.path.startsWith(path)),
    );
    if (!files.length || files.length > MAX_FILES)
      throw new BadRequestException(`单个技能最多包含 ${MAX_FILES} 个文件`);
    let total = 0;
    for (const file of files) {
      if (
        !safePackagePath(file.path.slice(directory.length)) ||
        file.type !== 'blob' ||
        !['100644', '100755'].includes(file.mode)
      )
        throw new BadRequestException('技能包含不支持的路径、符号链接或子模块');
      if (
        !Number.isInteger(file.size) ||
        file.size! < 0 ||
        file.size! > MAX_FILE ||
        !/^[a-f0-9]{40}$/.test(file.sha)
      )
        throw new BadRequestException('技能文件大小或版本不符合要求（单文件上限 512 KB）');
      total += file.size!;
    }
    if (total > MAX_TOTAL) throw new BadRequestException('技能文件总大小超过 4 MB');
    const result: SkillPackageFile[] = [];
    // 限制下载并发，复用当前预览截止时间；由不可变 blob SHA 固定全部文件内容。
    for (let offset = 0; offset < files.length; offset += 4) {
      const loaded = await Promise.all(
        files.slice(offset, offset + 4).map(async (file) => {
          const rawUrl = `https://raw.githubusercontent.com/${source.repository}/${commit.sha}/${file.path.split('/').map(encodeURIComponent).join('/')}`;
          const bytes = await this.bytes(rawUrl, signal, MAX_FILE, 'application/octet-stream');
          const sha = createHash('sha1')
            .update(`blob ${bytes.length}\0`)
            .update(bytes)
            .digest('hex');
          if (bytes.length !== file.size || bytes.length > MAX_FILE || sha !== file.sha)
            throw new BadRequestException('GitHub 文件校验失败，请重新解析');
          let text: string | undefined;
          try {
            if (!bytes.includes(0)) text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          } catch {
            /* 二进制文件保留 base64。 */
          }
          return {
            path: file.path.slice(directory.length),
            encoding: text === undefined ? ('base64' as const) : ('utf8' as const),
            content: text ?? bytes.toString('base64'),
            size: bytes.length,
            sha: file.sha,
          };
        }),
      );
      result.push(...loaded);
    }
    const manifest = result.find((file) => file.path === 'SKILL.md');
    if (!manifest || manifest.encoding !== 'utf8' || manifest.size > 60 * 1024)
      throw new BadRequestException('SKILL.md 必须为不超过 60 KB 的 UTF-8 文本');
    const meta = parseSkillManifest(manifest.content);
    const skill: SkillPackage = {
      name: meta.name,
      description: meta.description,
      systemPrompt: manifest.content,
      files: result,
      source: {
        kind: 'github',
        repository: source.repository,
        ref: version,
        revision: commit.sha,
        manifestPath: chosen.path,
        url: manifestUrl(chosen.path),
        originalName: meta.originalName,
        license: meta.license,
        compatibility: meta.compatibility,
        importedAt: new Date().toISOString(),
        fileCount: result.length,
        totalBytes: total,
      },
    };
    return { kind: 'preview' as const, skill };
  }
}
