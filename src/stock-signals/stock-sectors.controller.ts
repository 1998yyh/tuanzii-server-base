import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { QuerySectorsDto } from './dto/query-sectors.dto';
import { StockSectorsService } from './stock-sectors.service';

@ApiTags('Stock Signals')
@Controller('stock-signals/sectors')
export class StockSectorsController {
  constructor(private readonly sectors: StockSectorsService) {}

  @Get()
  @ApiOperation({ summary: '批量查询当前行业层级与主题概念（东方财富，公开只读）' })
  @ApiResponse({ status: 200, description: '逐只返回板块；取数失败标记 unavailable' })
  @ApiResponse({ status: 400, description: '股票代码非法或超过 50 只' })
  get(@Query() query: QuerySectorsDto) {
    return this.sectors.get(query.codes);
  }
}
