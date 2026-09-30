-- 生成任务增加来源标记：studio=生成台手动发起，canvas=画布发起。
-- 生成台列表（findTasks）只展示 studio；canvas 记录仍落库用于审计/排查，不参与视频轮询以外的任何链路。
-- 图片/音频是同步生成，task 行纯历史记录；视频行是 poller 回填依赖，画布视频任务仍标 studio 不隐藏。
ALTER TABLE generation_tasks
  ADD COLUMN source enum('studio', 'canvas') NOT NULL DEFAULT 'studio'
  COMMENT '任务来源：studio=生成台，canvas=画布' AFTER node_ref;

-- 可选：把历史里画布发起的图片任务揪出来藏掉（node_ref 非空的图片任务必来自画布；
-- Agent 工具路径没写 node_ref，捞不回来，只能放任留在生成台）。
-- UPDATE generation_tasks SET source = 'canvas' WHERE capability = 'image' AND node_ref IS NOT NULL;
