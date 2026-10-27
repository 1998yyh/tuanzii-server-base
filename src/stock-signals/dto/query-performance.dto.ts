import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';
import { QuerySectorsDto } from './query-sectors.dto';

export class QueryPerformanceDto extends QuerySectorsDto {
  @ApiProperty({
    example: '2026-09-10',
    description: '筛选日期；当日涨幅对应此日，距今涨幅以此日收盘为基准',
  })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date 必须为 YYYY-MM-DD 格式' })
  date!: string;
}
