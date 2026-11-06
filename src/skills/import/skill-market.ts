const entries = [
  ['frontend-design', '界面设计', '创建有辨识度的网页和组件，改善界面视觉与交互。', '设计'],
  ['pdf', 'PDF 处理', '读取、整理和生成 PDF，包含配套处理脚本与说明。', '文档'],
  ['docx', 'Word 文档', '创建和编辑 Word 文档，处理内容、格式与文档结构。', '文档'],
  ['pptx', '演示文稿', '创建、编辑和整理演示文稿及相关内容。', '文档'],
  ['xlsx', '电子表格', '处理电子表格、公式和数据整理任务。', '数据'],
  ['webapp-testing', '网页测试', '使用浏览器检查页面行为，辅助定位交互问题。', '开发'],
  ['mcp-builder', 'MCP 开发', '编写高质量 MCP 服务与工具接口。', '开发'],
  ['brand-guidelines', '品牌规范', '应用 Anthropic 提供的品牌颜色与排版规范。', '设计'],
];
export const SKILL_MARKET = entries.map(([slug, title, description, category]) => ({
  id: `anthropics/${slug}`,
  title,
  description,
  category,
  publisher: 'Anthropic',
  repository: 'anthropics/skills',
  url: `https://github.com/anthropics/skills/tree/main/skills/${slug}`,
}));
