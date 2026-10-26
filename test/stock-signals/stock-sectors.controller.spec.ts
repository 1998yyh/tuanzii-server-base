import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StockSectorsController } from 'src/stock-signals/stock-sectors.controller';
import { StockSectorsService } from 'src/stock-signals/stock-sectors.service';

describe('股票板块 HTTP 契约', () => {
  let app: INestApplication;
  let base: string;
  const get = jest.fn().mockResolvedValue({ items: [] });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [StockSectorsController],
      providers: [{ provide: StockSectorsService, useValue: { get } }],
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

  it('公开 GET 路由接收逗号代码并转换为数组，不需要登录', async () => {
    const response = await fetch(`${base}/api/stock-signals/sectors?codes=000030,600519`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [] });
    expect(get).toHaveBeenCalledWith(['000030', '600519']);
  });

  it.each(['', '?codes=invalid', '?codes=000030&url=http://localhost'])(
    '非法输入返回 400：%s',
    async (query) => {
      const response = await fetch(`${base}/api/stock-signals/sectors${query}`);
      expect(response.status).toBe(400);
    },
  );
});
