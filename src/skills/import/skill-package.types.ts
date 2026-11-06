export interface SkillPackageFile {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  size: number;
  sha: string;
}
export interface SkillSource {
  kind: 'github';
  repository: string;
  ref: string;
  revision: string;
  manifestPath: string;
  url: string;
  originalName: string;
  license?: string;
  compatibility?: string;
  importedAt: string;
  fileCount: number;
  totalBytes: number;
  modified?: boolean;
}
export interface SkillPackage {
  name: string;
  description: string;
  systemPrompt: string;
  source: SkillSource;
  files: SkillPackageFile[];
}
