import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
export class PreviewSkillDto {
  @ApiProperty({ example: 'https://github.com/anthropics/skills/tree/main/skills/pdf' })
  @IsString()
  @Length(1, 1000)
  url: string;
  @ApiProperty({ required: false, description: '可选分支、标签或提交 SHA' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  ref?: string;
}
export class ImportSkillDto {
  @ApiProperty({ description: '当前管理员的有效导入预览 ID' })
  @IsUUID('4')
  previewId: string;
  @ApiProperty({ description: '平台内技能名称' })
  @IsString()
  @Length(1, 100)
  @Matches(/^[a-z][a-z0-9_]*$/)
  name: string;
  @ApiProperty({ description: '技能用途描述，导入前可编辑' })
  @IsString()
  @Length(1, 500)
  description: string;
}
