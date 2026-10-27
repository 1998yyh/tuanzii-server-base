import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { QueryPerformanceDto } from './dto/query-performance.dto';
import { StockPerformanceService } from './stock-performance.service';

@ApiTags('Stock Signals')
@Controller('stock-signals/performance')
export class StockPerformanceController {
  constructor(private readonly performance: StockPerformanceService) {}

  @Get()
  @ApiOperation({
    summary: '公开查询筛选当日和筛选日收盘至今的涨幅（前复权，东方财富优先、腾讯备用）',
  })
  @ApiResponse({
    status: 200,
    description:
      '逐只返回涨幅、实际 source 与报价时间，同股不混用来源，缺失不填零；当日未收盘时距今涨幅为 null',
  })
  @ApiResponse({ status: 400, description: '日期非法、未来日期或代码超过 50 只' })
  get(@Query() query: QueryPerformanceDto) {
    return this.performance.get(query.date, query.codes);
  }
}
