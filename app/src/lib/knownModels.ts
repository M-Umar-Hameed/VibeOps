export type KnownModel = {
  id: string;
  name: string;
  tier: "free" | "cheap" | "expensive";
  quality: number; // 1-5
};

export const KNOWN_AGENT_MODELS: Record<string, KnownModel[]> = {
  claude: [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", tier: "expensive", quality: 5 },
    { id: "Fable 5.1", name: "Fable 5.1", tier: "expensive", quality: 5 },
    { id: "claude-opus-5", name: "Claude Opus 5", tier: "expensive", quality: 5 },
    { id: "Opus 5", name: "Opus 5", tier: "expensive", quality: 5 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", tier: "cheap", quality: 4 },
    { id: "Sonnet 5", name: "Sonnet 5", tier: "cheap", quality: 4 },
    { id: "claude-5", name: "Claude 5", tier: "expensive", quality: 5 },
    { id: "Claude 5", name: "Claude 5", tier: "expensive", quality: 5 },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", tier: "expensive", quality: 5 },
    { id: "Opus 4.8", name: "Opus 4.8", tier: "expensive", quality: 5 },
    { id: "Claude Opus 4.8", name: "Claude Opus 4.8", tier: "expensive", quality: 5 },
    { id: "claude-sonnet-4-8", name: "Claude Sonnet 4.8", tier: "cheap", quality: 4 },
    { id: "Sonnet 4.8", name: "Sonnet 4.8", tier: "cheap", quality: 4 },
    { id: "Claude Sonnet 4.8", name: "Claude Sonnet 4.8", tier: "cheap", quality: 4 },
    { id: "Claude 4.8", name: "Claude 4.8", tier: "expensive", quality: 5 },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tier: "free", quality: 3 },
    { id: "Haiku 4.5", name: "Haiku 4.5", tier: "free", quality: 3 },
  ],
  "claude-sdk": [
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", tier: "expensive", quality: 5 },
    { id: "Fable 5.1", name: "Fable 5.1", tier: "expensive", quality: 5 },
    { id: "claude-opus-5", name: "Claude Opus 5", tier: "expensive", quality: 5 },
    { id: "Opus 5", name: "Opus 5", tier: "expensive", quality: 5 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", tier: "cheap", quality: 4 },
    { id: "Sonnet 5", name: "Sonnet 5", tier: "cheap", quality: 4 },
    { id: "claude-5", name: "Claude 5", tier: "expensive", quality: 5 },
    { id: "Claude 5", name: "Claude 5", tier: "expensive", quality: 5 },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", tier: "expensive", quality: 5 },
    { id: "Opus 4.8", name: "Opus 4.8", tier: "expensive", quality: 5 },
    { id: "Claude Opus 4.8", name: "Claude Opus 4.8", tier: "expensive", quality: 5 },
    { id: "claude-sonnet-4-8", name: "Claude Sonnet 4.8", tier: "cheap", quality: 4 },
    { id: "Sonnet 4.8", name: "Sonnet 4.8", tier: "cheap", quality: 4 },
    { id: "Claude Sonnet 4.8", name: "Claude Sonnet 4.8", tier: "cheap", quality: 4 },
    { id: "Claude 4.8", name: "Claude 4.8", tier: "expensive", quality: 5 },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", tier: "free", quality: 3 },
    { id: "Haiku 4.5", name: "Haiku 4.5", tier: "free", quality: 3 },
  ],
  agy: [
    { id: "Gemini 3.8 Flash (High)", name: "Gemini 3.8 Flash (High)", tier: "cheap", quality: 4 },
    { id: "Gemini 3.8 Pro (High)", name: "Gemini 3.8 Pro (High)", tier: "expensive", quality: 5 },
    { id: "Gemini 3.5 Flash (High)", name: "Gemini 3.5 Flash (High)", tier: "cheap", quality: 3 },
    { id: "Gemini 3.5 Flash (Low)", name: "Gemini 3.5 Flash (Low)", tier: "free", quality: 2 },
    { id: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)", tier: "cheap", quality: 4 },
    { id: "Claude Opus 4.8 (High)", name: "Claude Opus 4.8 (High)", tier: "expensive", quality: 5 },
    { id: "Claude Sonnet 4.8 (High)", name: "Claude Sonnet 4.8 (High)", tier: "cheap", quality: 4 },
    { id: "Claude 4.8 (High)", name: "Claude 4.8 (High)", tier: "expensive", quality: 5 },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tier: "expensive", quality: 5 },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "cheap", quality: 3 },
    { id: "GPT-OSS 120B (Medium)", name: "GPT-OSS 120B (Medium)", tier: "free", quality: 2 },
  ],
  gemini: [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", tier: "expensive", quality: 5 },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", tier: "cheap", quality: 3 },
    { id: "gemini-2.0-flash", name: "Gemini 2.0 Flash", tier: "cheap", quality: 3 },
    { id: "gemini-1.5-pro", name: "Gemini 1.5 Pro", tier: "expensive", quality: 4 },
    { id: "gemini-1.5-flash", name: "Gemini 1.5 Flash", tier: "cheap", quality: 3 },
  ],
  codex: [
    { id: "gpt-5.6-sol", name: "GPT-5.6 Sol", tier: "expensive", quality: 5 },
    { id: "gpt-5.6-terra", name: "GPT-5.6 Terra", tier: "expensive", quality: 5 },
    { id: "gpt-5.6-luna", name: "GPT-5.6 Luna", tier: "expensive", quality: 5 },
    { id: "gpt-5.5", name: "GPT-5.5", tier: "cheap", quality: 4 },
    { id: "gpt-5.4", name: "GPT-5.4", tier: "cheap", quality: 3 },
    { id: "o1", name: "OpenAI o1", tier: "expensive", quality: 5 },
    { id: "o3-mini", name: "OpenAI o3-mini", tier: "cheap", quality: 4 },
    { id: "gpt-4o", name: "GPT-4o", tier: "cheap", quality: 4 },
    { id: "gpt-4o-mini", name: "GPT-4o mini", tier: "free", quality: 2 },
  ],
  kimi: [
    { id: "kimi-k3", name: "Kimi K3", tier: "cheap", quality: 5 },
    { id: "Kimi K3", name: "Kimi K3", tier: "cheap", quality: 5 },
    { id: "moonshotai/kimi-k3", name: "Moonshot Kimi K3", tier: "cheap", quality: 5 },
    { id: "kimi-k3-thinking", name: "Kimi K3 Thinking", tier: "expensive", quality: 5 },
    { id: "kimi-k3.5", name: "Kimi K3.5", tier: "cheap", quality: 5 },
    { id: "moonshot-ai/kimi-k2.7-code", name: "Kimi K2.7 Code", tier: "cheap", quality: 4 },
    { id: "kimi-k2.7-code", name: "Kimi K2.7 Code (alias)", tier: "cheap", quality: 4 },
    { id: "kimi-k2.5", name: "Kimi K2.5", tier: "cheap", quality: 3 },
    { id: "kimi-k2-code", name: "Kimi K2 Code", tier: "cheap", quality: 3 },
    { id: "moonshot-v1-8k", name: "Moonshot v1 8K", tier: "cheap", quality: 3 },
    { id: "moonshot-v1-32k", name: "Moonshot v1 32K", tier: "cheap", quality: 3 },
    { id: "moonshot-v1-128k", name: "Moonshot v1 128K", tier: "expensive", quality: 4 },
  ],
};

export function getKnownModelsForAgent(agentName: string): KnownModel[] {
  const lower = (agentName || "").toLowerCase();
  if (KNOWN_AGENT_MODELS[lower]) return KNOWN_AGENT_MODELS[lower];
  for (const [key, models] of Object.entries(KNOWN_AGENT_MODELS)) {
    if (lower.includes(key)) return models;
  }
  return [];
}
