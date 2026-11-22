export type Model = 'deepseek-v4-pro' | 'deepseek-flash';

export const MODELS: { id: Model; name: string; short: string; description: string }[] = [
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4-Pro',
    short: 'V4-Pro',
    description: '最强推理与通用能力',
  },
  {
    id: 'deepseek-flash',
    name: 'DeepSeek V4.1 Flash',
    short: 'Flash',
    description: '快速响应，支持联网与文件',
  },
];

export function normalizeModel(value: string | null | undefined): Model {
  return value === 'deepseek-flash' ? 'deepseek-flash' : 'deepseek-v4-pro';
}

export interface Attachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  kind: 'image' | 'document' | 'text';
  url: string;
}

export interface SystemPrompt {
  id: number;
  name: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface Quote {
  id: number;
  role: 'user' | 'assistant';
  content: string;
}

export interface Source {
  type?: string;
  url: string;
  title?: string | null;
  snippet?: string | null;
  site_name?: string | null;
  site_icon?: string | null;
  published_at?: string | null;
}

export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error' | 'interrupted';

export interface Conversation {
  id: number;
  title: string;
  model: Model;
  active_leaf_id?: number | null;
  system_prompt_id?: number | null;
  system_prompt_name?: string;
  system_prompt_text?: string;
  single_turn?: boolean;
  created_at: number;
  updated_at: number;
  preview?: string | null;
  message_count?: number;
}

export interface Message {
  id: number;
  conversation_id: number;
  parent_id?: number | null;
  version_ids?: number[];
  version_count?: number;
  version_index?: number;
  role: 'user' | 'assistant';
  content: string;
  reasoning: string;
  status: MessageStatus;
  error: string;
  model: Model | null;
  web_search?: boolean;
  thinking?: boolean;
  searching?: boolean;
  sources?: Source[];
  annotations?: unknown[];
  attachments?: Attachment[];
  quotes?: Quote[];
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  cached_tokens?: number | null;
  created_at: number;
  updated_at: number;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
}

export interface SearchResult {
  conversation_id: number;
  conversation_title: string;
  message_id: number | null;
  role: 'user' | 'assistant' | null;
  snippet: string;
  updated_at: number;
}

export interface ChatMeta {
  conversation: Conversation;
  user_message: Message | null;
  assistant_message: Message;
  model: Model;
}

export interface ChatDone {
  message: Message | null;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  stopped?: boolean;
}

export interface ChatError {
  message: string;
  message_data?: Message | null;
}
