// 模型厂商预设（国内主流 + 本地自建）。统一走 OpenAI 兼容协议：
// 平台只关心三件事 —— endpoint / model / api_key。
// 这里的清单只用于「下拉一键填充」，用户随时可以手改。

export interface LlmPreset {
  vendor: string;
  label: string;
  endpoint: string;
  models: string[];
  local?: boolean;      // 本地/自建模型：通常不出网、密钥可留空
  keyHint?: string;     // 密钥输入框占位提示
  note?: string;        // 额外说明（如豆包要填接入点 ID）
}

export const LLM_PRESETS: LlmPreset[] = [
  { vendor: 'deepseek', label: 'DeepSeek 深度求索', endpoint: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'], keyHint: 'sk-xxxxxxxx' },
  { vendor: 'qwen', label: '阿里通义千问（百炼）', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen2.5-72b-instruct', 'qwen2.5-coder-32b-instruct'], keyHint: 'sk-xxxxxxxx' },
  { vendor: 'zhipu', label: '智谱 GLM', endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4-9b-chat'], keyHint: 'id.secret' },
  { vendor: 'doubao', label: '字节豆包（火山方舟）', endpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['ep-2024-xxxxxx-xxxxx'], keyHint: '方舟 API Key',
    note: '模型名填火山方舟控制台的「接入点 ID」（ep- 开头）' },
  { vendor: 'moonshot', label: '月之暗面 Kimi', endpoint: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'], keyHint: 'sk-xxxxxxxx' },
  { vendor: 'hunyuan', label: '腾讯混元', endpoint: 'https://api.hunyuan.cloud.tencent.com/v1',
    models: ['hunyuan-turbo', 'hunyuan-pro', 'hunyuan-standard'], keyHint: 'sk-xxxxxxxx' },
  { vendor: 'qianfan', label: '百度千帆（文心）', endpoint: 'https://qianfan.baidubce.com/v2',
    models: ['ernie-4.0-8k', 'ernie-3.5-8k', 'ernie-speed-8k'], keyHint: 'bce-v3/...' },
  { vendor: 'spark', label: '讯飞星火', endpoint: 'https://spark-api-open.xf-yun.com/v1',
    models: ['lite', 'generalv3', 'generalv3.5', '4.0Ultra'], keyHint: 'APIKey:APISecret' },
  { vendor: 'minimax', label: 'MiniMax', endpoint: 'https://api.minimax.chat/v1',
    models: ['abab6.5s-chat', 'abab6.5-chat', 'MiniMax-Text-01'], keyHint: 'sk-xxxxxxxx' },
  { vendor: 'siliconflow', label: '硅基流动 SiliconFlow', endpoint: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'THUDM/glm-4-9b-chat'], keyHint: 'sk-xxxxxxxx' },
  { vendor: 'ollama', label: '本地 Ollama', endpoint: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b', 'glm4:9b'], local: true, keyHint: '本地可不填（或填 ollama）' },
  { vendor: 'vllm', label: '本地 vLLM', endpoint: 'http://127.0.0.1:8000/v1',
    models: ['qwen2.5-7b-instruct'], local: true, keyHint: '自建服务若无鉴权可留空' },
  { vendor: 'xinference', label: '本地 Xinference', endpoint: 'http://127.0.0.1:9997/v1',
    models: ['qwen2.5-instruct'], local: true, keyHint: '可留空' },
  { vendor: 'lmstudio', label: '本地 LM Studio', endpoint: 'http://127.0.0.1:1234/v1',
    models: ['local-model'], local: true, keyHint: '可留空（或填 lm-studio）' },
  { vendor: 'custom', label: '自定义（OpenAI 兼容）', endpoint: '', models: [], keyHint: '可留空' },
];

export function presetOf(vendor: string): LlmPreset | undefined {
  return LLM_PRESETS.find((p) => p.vendor === vendor);
}
export function vendorLabel(vendor: string): string {
  return presetOf(vendor)?.label ?? vendor;
}

// 新增模型表单的初始状态：默认选中 DeepSeek 并预填其字段，
// 避免「下拉显示 DeepSeek 但输入框全空、点击同项不触发 onChange」的问题。
export function initialProviderForm(isDefault: boolean) {
  const p = LLM_PRESETS.find((x) => x.vendor === 'deepseek');
  return {
    name: p?.label ?? '',
    vendor: 'deepseek',
    endpoint: p?.endpoint ?? '',
    model: p?.models?.[0] ?? '',
    apiKey: '',
    isDefault,
  };
}
