import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, Matches } from 'class-validator';

export class QuerySectorsDto {
  @ApiProperty({
    example: '000030,600519',
    description: '逗号分隔的沪深主板代码，最多 50 只；返回当前板块归属，不是历史快照',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.split(',') : value,
  )
  @IsArray({ message: 'codes 必须为逗号分隔的股票代码' })
  @ArrayMinSize(1, { message: '至少提供一只股票' })
  @ArrayMaxSize(50, { message: '单次最多查询 50 只股票' })
  @Matches(/^(?:000|001|002|003|600|601|603|605)\d{3}$/, {
    each: true,
    message: '仅支持六位沪深主板股票代码',
  })
  codes!: string[];
}
