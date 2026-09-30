// 本机浏览器联调夹具：仅监听回环地址，账号与日志为隔离样例，不连接 MySQL。
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { ValidationPipe } = require('@nestjs/common');
const { JwtModule } = require('@nestjs/jwt');
const { ConfigService } = require('@nestjs/config');
const { PassportModule } = require('@nestjs/passport');
const { randomUUID } = require('node:crypto');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const bcrypt = require('bcrypt');
const root = join(__dirname, '..', 'dist', 'src');
const { AuthController } = require(root + '/auth/auth.controller.js');
const { AuthService } = require(root + '/auth/auth.service.js');
const { JwtStrategy } = require(root + '/auth/jwt.strategy.js');
const { UsersService } = require(root + '/users/users.service.js');
const { LogsController, LogsAdminGuard } = require(root + '/logs/logs.controller.js');
const { LogStore } = require(root + '/logs/log-store.js');
(async () => {
  const directory = await mkdtemp(join(tmpdir(), 'admin-console-integration-'));
  const store = new LogStore({ directory });
  await store.initialize();
  for (let i = 0; i < 67; i++)
    store.write(i % 4 === 0 ? 'error' : 'info', {
      message: i % 4 === 0 ? '联调样例：模型接口返回错误' : '联调样例：请求处理完成',
      event: i % 4 === 0 ? 'agent.run.failed' : 'http.request.completed',
      requestId: 'request-' + (i % 5),
      conversationId: 'conversation-' + (i % 3),
      modelName: 'integration-model',
      channelId: 'channel-test',
      upstreamStatus: i % 4 === 0 ? 400 : undefined,
      stack: i % 4 === 0 ? 'Error: 联调样例错误\n    at integration.fixture' : undefined,
    });
  await store.flush();
  const password = await bcrypt.hash('integration-only', 10);
  const users = [
    {
      id: 'admin-id',
      username: 'integration-admin',
      email: 'admin@test.invalid',
      password,
      role: 'admin',
    },
    {
      id: 'user-id',
      username: 'integration-user',
      email: 'user@test.invalid',
      password,
      role: 'user',
    },
  ];
  const secret = randomUUID();
  const module = await Test.createTestingModule({
    imports: [PassportModule, JwtModule.register({ secret })],
    controllers: [AuthController, LogsController],
    providers: [
      AuthService,
      JwtStrategy,
      LogsAdminGuard,
      { provide: LogStore, useValue: store },
      {
        provide: ConfigService,
        useValue: { get: (key) => (key === 'JWT_SECRET' ? secret : undefined) },
      },
      {
        provide: UsersService,
        useValue: {
          findById: async (id) => users.find((u) => u.id === id),
          findByEmail: async (email) => users.find((u) => u.email === email),
          findByUsername: async (username) => users.find((u) => u.username === username),
          validatePassword: bcrypt.compare,
        },
      },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }),
  );
  await app.listen(5210, '127.0.0.1');
  console.log(
    'Integration fixture ready on 5210; real AuthService, JwtStrategy, LogsController and LogStore; isolated users and temporary logs.',
  );
  async function close() {
    await app.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
    process.exit(0);
  }
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
