import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class QueryXiaofeiyuDiaryDto {
  @ApiPropertyOptional({ example: '今天', description: '标题或正文包含的文字，最多200字' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ example: '1', enum: ['0', '1'], description: '1仅未读，0全部' })
  @IsIn(['0', '1'])
  unread: string = '0';

  @ApiPropertyOptional({ example: 1, default: 1, description: '页码，从1开始' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000000)
  page: number = 1;

  @ApiPropertyOptional({ example: 30, default: 30, maximum: 100, description: '每页数量' })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 30;
}

export class ReceiveXiaofeiyuDiaryDto {
  @ApiPropertyOptional({ example: '小肥鱼日记', description: '日记标题，省略时使用默认标题' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  title?: string;

  @ApiPropertyOptional({
    example: '今天也有认真过日子。',
    description: '纯文本正文，优先于content',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  text?: string;

  @ApiPropertyOptional({ example: '今天也有认真过日子。', description: '兼容插件的正文备用字段' })
  @IsOptional()
  @IsString()
  @MaxLength(100000)
  content?: string;

  @ApiPropertyOptional({
    example: 'text',
    enum: ['text', 'markdown'],
    description: '插件消息格式，均按纯文本保存',
  })
  @IsOptional()
  @IsIn(['text', 'markdown'])
  format?: string;
}

export class XiaofeiyuWebhookCredentialsDto {
  @ApiPropertyOptional({ description: '兼容插件的推送密钥；推荐改用X-Xiaofeiyu-Key请求头' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  key?: string;
}
