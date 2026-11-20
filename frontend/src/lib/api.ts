import type {
  ChatDone,
  ChatError,
  ChatMeta,
  Conversation,
  ConversationDetail,
  Message,
  Attachment,
  Model,
  SearchResult,
  Source,
} from '../types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function unauthorized(): void {
  window.dispatchEvent(new Event('dschat:unauthorized'));
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  options: { auth?: boolean } = {},
): Promise<T> {
  const auth = options.auth !== false;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers,
  });

  if (response.status === 401 && auth) {
    unauthorized();
    throw new ApiError(401, '登录已过期，请重新登录');
  }

  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const data = (await response.json()) as { detail?: string; message?: string };
      message = data.detail || data.message || message;
    } catch {
      // ignore non-JSON error body
    }
    throw new ApiError(response.status, message);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export async function getSession(): Promise<{ authenticated: boolean }> {
  return request('/api/auth/session', {}, { auth: false });
}

export async function login(password: string): Promise<{ ok: boolean }> {
  return request(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ password }) },
    { auth: false },
  );
}

export async function logout(): Promise<{ ok: boolean }> {
  return request('/api/auth/logout', { method: 'POST' }, { auth: false });
}

export async function listConversations(): Promise<{ conversations: Conversation[] }> {
  return request('/api/conversations');
}

export async function searchGlobal(query: string): Promise<{ results: SearchResult[] }> {
  return request(`/api/search?q=${encodeURIComponent(query)}`);
}

export async function uploadAttachment(file: File): Promise<{ attachment: Attachment }> {
  const form = new FormData();
  form.append('file', file);
  const response = await fetch('/api/files', {
    method: 'POST',
    credentials: 'include',
    body: form,
  });
  if (response.status === 401) {
    unauthorized();
    throw new ApiError(401, '登录已过期，请重新登录');
  }
  if (!response.ok) {
    let message = `上传失败（HTTP ${response.status}）`;
    try {
      const data = (await response.json()) as { detail?: string };
      message = data.detail || message;
    } catch {
      // ignore
    }
    throw new ApiError(response.status, message);
  }
  return (await response.json()) as { attachment: Attachment };
}

export async function deleteAttachment(attachmentId: string): Promise<{ ok: boolean }> {
  return request(`/api/files/${attachmentId}`, { method: 'DELETE' });
}

export async function getConversation(id: number): Promise<ConversationDetail> {
  return request(`/api/conversations/${id}`);
}

export async function activateMessage(
  conversationId: number,
  messageId: number,
): Promise<ConversationDetail> {
  return request(
    `/api/conversations/${conversationId}/messages/${messageId}/activate`,
    { method: 'POST' },
  );
}

export async function renameConversation(
  id: number,
  title: string,
): Promise<{ conversation: Conversation }> {
  return request(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export async function setConversationModel(
  id: number,
  model: Model,
): Promise<{ conversation: Conversation }> {
  return request(`/api/conversations/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ model }),
  });
}

export async function deleteConversation(id: number): Promise<{ ok: boolean }> {
  return request(`/api/conversations/${id}`, { method: 'DELETE' });
}

export async function stopConversation(id: number): Promise<{ ok: boolean }> {
  return request(`/api/conversations/${id}/stop`, { method: 'POST' });
}

export interface StreamHandlers {
  onMeta?: (data: ChatMeta) => void;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onDone?: (data: ChatDone) => void;
  onError?: (data: ChatError) => void;
  onSearch?: (queries: string[]) => void;
  onSources?: (sources: Source[]) => void;
}

interface StreamOptions {
  path: string;
  body: Record<string, unknown>;
  handlers: StreamHandlers;
  signal?: AbortSignal;
}

async function streamRequest({ path, body, handlers, signal }: StreamOptions): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (response.status === 401) {
    unauthorized();
    throw new ApiError(401, '登录已过期，请重新登录');
  }

  if (!response.ok) {
    let message = `请求失败（HTTP ${response.status}）`;
    try {
      const data = (await response.json()) as { detail?: string; message?: string };
      message = data.detail || data.message || message;
    } catch {
      // ignore
    }
    throw new ApiError(response.status, message);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ApiError(0, '浏览器不支持流式响应');
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let finished = false;
  let serverError = false;

  const dispatch = (block: string): void => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (!dataLines.length) return;

    let data: unknown;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }

    if (eventName === 'meta') {
      handlers.onMeta?.(data as ChatMeta);
    } else if (eventName === 'delta') {
      const payload = data as { content?: string };
      if (payload.content) handlers.onDelta?.(payload.content);
    } else if (eventName === 'reasoning') {
      const payload = data as { content?: string };
      if (payload.content) handlers.onReasoning?.(payload.content);
    } else if (eventName === 'search') {
      const payload = data as { queries?: string[] };
      handlers.onSearch?.(payload.queries || []);
    } else if (eventName === 'sources') {
      const payload = data as { sources?: Source[] };
      handlers.onSources?.(payload.sources || []);
    } else if (eventName === 'done') {
      finished = true;
      handlers.onDone?.(data as ChatDone);
    } else if (eventName === 'error') {
      serverError = true;
      finished = true;
      handlers.onError?.(data as ChatError);
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      dispatch(block);
      boundary = buffer.indexOf('\n\n');
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    dispatch(buffer);
  }

  if (!finished && !serverError) {
    throw new ApiError(0, '连接中断，请重试');
  }
}

export async function streamChat(
  conversationId: number | null,
  content: string,
  model: Model,
  webSearch: boolean,
  thinking: boolean,
  attachmentIds: string[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamRequest({
    path: '/api/chat',
    body: {
      conversation_id: conversationId,
      content,
      model,
      web_search: webSearch,
      thinking,
      attachment_ids: attachmentIds,
    },
    handlers,
    signal,
  });
}

export async function regenerate(
  conversationId: number,
  model: Model,
  webSearch: boolean,
  thinking: boolean,
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamRequest({
    path: `/api/conversations/${conversationId}/regenerate`,
    body: { model, web_search: webSearch, thinking },
    handlers,
    signal,
  });
}

export async function editMessage(
  conversationId: number,
  messageId: number,
  content: string,
  model: Model,
  webSearch: boolean,
  thinking: boolean,
  attachmentIds: string[],
  handlers: StreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  return streamRequest({
    path: `/api/conversations/${conversationId}/messages/${messageId}/edit`,
    body: {
      content,
      model,
      web_search: webSearch,
      thinking,
      attachment_ids: attachmentIds,
    },
    handlers,
    signal,
  });
}

export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  if (!incoming.length) return current;
  const map = new Map<number, Message>();
  for (const message of current) map.set(message.id, message);

  let changed = false;
  for (const message of incoming) {
    const previous = map.get(message.id);
    if (
      !previous ||
      previous.content !== message.content ||
      previous.reasoning !== message.reasoning ||
      previous.status !== message.status ||
      previous.error !== message.error ||
      previous.updated_at !== message.updated_at
    ) {
      map.set(message.id, message);
      changed = true;
    }
  }

  // 轮询会反复带回最后一条消息；内容没变时保持原数组，避免无意义的重渲染和滚动副作用。
  if (!changed) return current;
  return [...map.values()].sort((a, b) => a.id - b.id);
}
