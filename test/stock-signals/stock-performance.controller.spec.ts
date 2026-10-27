import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StockPerformanceController } from 'src/stock-signals/stock-performance.controller';
import { StockPerformanceService } from 'src/stock-signals/stock-performance.service';

describe('涨幅公开 HTTP 契约', () => {
  let app: INestApplication, base: string;
  const get = jest.fn().mockResolvedValue({ items: [] });
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StockPerformanceController],
      providers: [{ provide: StockPerformanceService, useValue: { get } }],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
    );
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => app.close());
  it('无需登录，日期与代码原样送入计算服务', async () => {
    const response = await fetch(
      `${base}/api/stock-signals/performance?date=2026-09-10&codes=600396,000030`,
    );
    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith('2026-09-10', ['600396', '000030']);
  });
  it.each([
    '?codes=600396',
    '?date=bad&codes=600396',
    '?date=2026-09-10&codes=300001',
    '?date=2026-09-10&codes=600396&url=http://localhost',
    `?date=2026-09-10&codes=${Array(51).fill('600396').join(',')}`,
  ])('非法参数返回 400：%s', async (query) => {
    expect((await fetch(`${base}/api/stock-signals/performance${query}`)).status).toBe(400);
  });
});
