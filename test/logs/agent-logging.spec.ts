import { BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { ConversationsController } from 'src/agents/conversations.controller';
import { ConversationsService } from 'src/agents/conversations.service';

it('SSE 的 HTTP 200 失败仍记录结构化模型错误和会话，不记录聊天正文', async () => {
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const config = { id: 'agent1', channelId: 'channel1', modelName: 'model1' };
  const service = {
    prepareStream: jest.fn().mockResolvedValue({ id: 'conversation1', agentConfig: config }),
    streamMessages: async function* () {
      yield { type: 'message_start', data: {} };
      throw new BadRequestException('搜索接口不支持');
    },
  };
  const response = Object.assign(new EventEmitter(), {
    status: jest.fn(),
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
  });
  try {
    await new ConversationsController(service as unknown as ConversationsService).sendMessage(
      { id: 'user1' } as any,
      'conversation1',
      { content: '秘密聊天正文' },
      'true',
      response as any,
    );
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'agent.run.failed',
        conversationId: 'conversation1',
        channelId: 'channel1',
        modelName: 'model1',
        upstreamStatus: 400,
      }),
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('秘密聊天正文');
    expect(response.status).toHaveBeenCalledWith(200);
  } finally {
    error.mockRestore();
    log.mockRestore();
  }
});
