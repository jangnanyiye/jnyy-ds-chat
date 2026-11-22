import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { ChatView } from './components/ChatView';
import { Composer } from './components/Composer';
import { Login } from './components/Login';
import { Logo } from './components/Logo';
import { Modal } from './components/Modal';
import { Sidebar } from './components/Sidebar';
import { SearchDialog } from './components/SearchDialog';
import { ToastViewport, type ToastItem } from './components/Toast';
import {
  activateMessage,
  ApiError,
  deleteAttachment,
  deleteConversation,
  editMessage as editMessageRequest,
  getConversation,
  getSession,
  listConversations,
  listPrompts,
  login,
  logout,
  regenerate as regenerateRequest,
  renameConversation,
  setConversationModel,
  setConversationSettings,
  stopConversation,
  streamChat,
  uploadAttachment,
  type StreamHandlers,
} from './lib/api';
import { PromptLibrary } from './components/PromptLibrary';
import { SettingsDialog } from './components/SettingsDialog';
import {
  initialTheme,
  isDarkLocked,
  loadPreferences,
  savePreferences,
  setDarkLocked,
  type Preferences,
} from './lib/prefs';
import {
  normalizeModel,
  type Attachment,
  type Conversation,
  type Message,
  type Model,
  type SearchResult,
  type SystemPrompt,
} from './types';

type AuthState = 'loading' | 'out' | 'in';
type Theme = 'light' | 'dark';

const LAST_KEY = 'dschat.last';
const SIDEBAR_KEY = 'dschat.sidebar';
const WEB_SEARCH_KEY = 'dschat.websearch';
const THINKING_KEY = 'dschat.thinking';
const MAX_ATTACHMENTS = 6;
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

function upsertConversation(list: Conversation[], conversation: Conversation): Conversation[] {
  const existing = list.find((item) => item.id === conversation.id);
  const merged = { ...existing, ...conversation };
  return [merged, ...list.filter((item) => item.id !== conversation.id)].sort(
    (a, b) => b.updated_at - a.updated_at || b.id - a.id,
  );
}

function updateMessage(list: Message[], id: number | null, updater: (message: Message) => Message): Message[] {
  if (id === null) return list;
  return list.map((message) => (message.id === id ? updater(message) : message));
}

function replaceMessage(list: Message[], id: number | null, replacement: Message): Message[] {
  if (id === null) return list;
  return list.map((message) => (message.id === id ? replacement : message));
}

function messagesEqual(a: Message[], b: Message[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (
      left.id !== right.id ||
      left.content !== right.content ||
      left.reasoning !== right.reasoning ||
      left.status !== right.status ||
      left.error !== right.error ||
      left.updated_at !== right.updated_at ||
      left.version_index !== right.version_index ||
      left.version_count !== right.version_count
    ) {
      return false;
    }
  }
  return true;
}

function syncUrl(conversationId: number | null): void {
  const url = new URL(window.location.href);
  if (conversationId) url.searchParams.set('c', String(conversationId));
  else url.searchParams.delete('c');
  window.history.replaceState(null, '', url);
}

function makeTempMessage(conversationId: number, role: 'user' | 'assistant', content: string): Message {
  const now = Date.now();
  return {
    id: role === 'user' ? -now : -now - 1,
    conversation_id: conversationId,
    role,
    content,
    reasoning: '',
    status: role === 'assistant' ? 'streaming' : 'complete',
    error: '',
    model: null,
    created_at: now,
    updated_at: now,
  };
}

export default function App() {
  const [auth, setAuth] = useState<AuthState>('loading');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const [loadingMoreConversations, setLoadingMoreConversations] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [model, setModel] = useState<Model>('deepseek-v4-pro');
  const [input, setInput] = useState('');
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem(SIDEBAR_KEY) === 'collapsed',
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightMessageId, setHighlightMessageId] = useState<number | null>(null);
  const [webSearch, setWebSearch] = useState(
    () => localStorage.getItem(WEB_SEARCH_KEY) === '1',
  );
  const [deepThinking, setDeepThinking] = useState(
    () => localStorage.getItem(THINKING_KEY) === '1',
  );
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState<{ id: string; name: string }[]>([]);
  const [prompts, setPrompts] = useState<SystemPrompt[]>([]);
  const [systemPromptId, setSystemPromptId] = useState<number | null>(null);
  const [systemPromptName, setSystemPromptName] = useState('');
  const [systemPromptText, setSystemPromptText] = useState('');
  const [singleTurn, setSingleTurn] = useState(false);
  const [quotedMessages, setQuotedMessages] = useState<Message[]>([]);
  const [promptLibraryOpen, setPromptLibraryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>(loadPreferences);
  const [darkLock, setDarkLock] = useState(isDarkLocked);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [renameTarget, setRenameTarget] = useState<Conversation | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);

  const activeIdRef = useRef<number | null>(null);
  const messagesRef = useRef<Message[]>([]);
  const conversationsRef = useRef<Conversation[]>([]);
  const modelRef = useRef<Model>('deepseek-v4-pro');
  const streamingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const assistantIdRef = useRef<number | null>(null);
  const stoppedRef = useRef(false);
  const toastIdRef = useRef(0);
  const loadTokenRef = useRef(0);
  const pendingAttachmentsRef = useRef<Attachment[]>([]);
  const uploadingCountRef = useRef(0);
  const attachmentEpochRef = useRef(0);

  const activeConversation = conversations.find((item) => item.id === activeId) || null;
  const title = activeConversation?.title || '新对话';
  const isGenerating = streaming || messages.some((message) => message.status === 'streaming');

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  useEffect(() => {
    modelRef.current = model;
  }, [model]);

  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);

  useEffect(() => {
    pendingAttachmentsRef.current = pendingAttachments;
  }, [pendingAttachments]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#212327' : '#ffffff');
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, sidebarCollapsed ? 'collapsed' : 'open');
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem(WEB_SEARCH_KEY, webSearch ? '1' : '0');
    if (webSearch && modelRef.current !== 'deepseek-flash') {
      setModel('deepseek-flash');
      modelRef.current = 'deepseek-flash';
    }
  }, [webSearch]);

  useEffect(() => {
    localStorage.setItem(THINKING_KEY, deepThinking ? '1' : '0');
  }, [deepThinking]);

  const updatePreferences = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      savePreferences(next);
      return next;
    });
  }, []);

  const toggleDarkLock = useCallback((locked: boolean) => {
    setDarkLock(locked);
    setDarkLocked(locked);
    if (locked) setTheme('dark');
  }, []);

  useEffect(() => {
    if (auth !== 'in') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [auth]);

  useEffect(() => {
    document.title = activeConversation ? `${activeConversation.title} - DeepSeek Chat` : 'DeepSeek Chat';
  }, [activeConversation]);

  const showToast = useCallback((message: string, type: ToastItem['type'] = 'info') => {
    const id = ++toastIdRef.current;
    setToasts((current) => [...current.slice(-2), { id, type, message }]);
    window.setTimeout(
      () => setToasts((current) => current.filter((toast) => toast.id !== id)),
      type === 'error' ? 5000 : 3000,
    );
  }, []);

  const reloadActiveConversation = useCallback(async (conversationId: number) => {
    try {
      const data = await getConversation(conversationId);
      if (activeIdRef.current !== conversationId) return;
      setMessages(data.messages);
      setConversations((current) => upsertConversation(current, data.conversation));
      setModel(data.conversation.model);
      modelRef.current = data.conversation.model;
      setSystemPromptId(data.conversation.system_prompt_id ?? null);
      setSystemPromptName(data.conversation.system_prompt_name ?? '');
      setSystemPromptText(data.conversation.system_prompt_text ?? '');
      setSingleTurn(Boolean(data.conversation.single_turn));
    } catch {
      // 刷新失败不影响已经展示的内容，下一次轮询会再试
    }
  }, []);

  const switchVersion = useCallback(
    async (messageId: number) => {
      const conversationId = activeIdRef.current;
      if (!conversationId || streamingRef.current) return;
      const loadToken = ++loadTokenRef.current;
      setLoadingConversation(true);
      try {
        const data = await activateMessage(conversationId, messageId);
        if (loadToken !== loadTokenRef.current || activeIdRef.current !== conversationId) return;
        setMessages(data.messages);
        setConversations((current) => upsertConversation(current, data.conversation));
        setModel(data.conversation.model);
        modelRef.current = data.conversation.model;
        setSystemPromptId(data.conversation.system_prompt_id ?? null);
        setSystemPromptName(data.conversation.system_prompt_name ?? '');
        setSystemPromptText(data.conversation.system_prompt_text ?? '');
        setSingleTurn(Boolean(data.conversation.single_turn));
        setQuotedMessages([]);
        setEditingMessage(null);
        setInput('');
      } catch (error) {
        if (loadToken === loadTokenRef.current) {
          showToast(error instanceof ApiError ? error.message : '切换分支失败', 'error');
        }
      } finally {
        if (loadToken === loadTokenRef.current) setLoadingConversation(false);
      }
    },
    [showToast],
  );

  const openSidebar = useCallback(() => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setSidebarOpen(true);
    } else {
      setSidebarCollapsed(false);
    }
  }, []);

  const closeSidebar = useCallback(() => {
    if (window.matchMedia('(max-width: 900px)').matches) {
      setSidebarOpen(false);
    } else {
      setSidebarCollapsed(true);
    }
  }, []);

  const discardPendingAttachments = useCallback(() => {
    attachmentEpochRef.current += 1;
    const items = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
    setUploadingFiles([]);
    uploadingCountRef.current = 0;
    for (const attachment of items) {
      void deleteAttachment(attachment.id).catch(() => undefined);
    }
  }, []);

  const ensureFlashForFiles = useCallback(() => {
    if (modelRef.current === 'deepseek-flash') return;
    setModel('deepseek-flash');
    modelRef.current = 'deepseek-flash';
    const conversationId = activeIdRef.current;
    if (conversationId) {
      void setConversationModel(conversationId, 'deepseek-flash')
        .then(({ conversation }) => {
          setConversations((current) => upsertConversation(current, conversation));
        })
        .catch(() => undefined);
    }
    showToast('文件输入需要 DeepSeek V4.1 Flash，已自动切换', 'info');
  }, [showToast]);

  const handleFiles = useCallback(
    async (files: File[]) => {
      if (!files.length || streamingRef.current) return;
      const available =
        MAX_ATTACHMENTS -
        pendingAttachmentsRef.current.length -
        uploadingCountRef.current;
      if (available <= 0) {
        showToast(`最多上传 ${MAX_ATTACHMENTS} 个附件`, 'info');
        return;
      }
      if (files.length > available) {
        showToast(`最多上传 ${MAX_ATTACHMENTS} 个附件，已忽略多余文件`, 'info');
      }
      const selected = files.slice(0, available);
      const epoch = attachmentEpochRef.current;

      await Promise.all(
        selected.map(async (file) => {
          if (file.size > MAX_UPLOAD_BYTES) {
            showToast(`${file.name} 超过 100 MB`, 'error');
            return;
          }
          const uploadId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          uploadingCountRef.current += 1;
          setUploadingFiles((current) => [...current, { id: uploadId, name: file.name }]);
          try {
            const { attachment } = await uploadAttachment(file);
            if (epoch !== attachmentEpochRef.current) {
              void deleteAttachment(attachment.id).catch(() => undefined);
              return;
            }
            pendingAttachmentsRef.current = [
              ...pendingAttachmentsRef.current,
              attachment,
            ];
            setPendingAttachments(pendingAttachmentsRef.current);
            ensureFlashForFiles();
          } catch (error) {
            showToast(
              error instanceof ApiError ? error.message : `${file.name} 上传失败`,
              'error',
            );
          } finally {
            uploadingCountRef.current -= 1;
            setUploadingFiles((current) =>
              current.filter((item) => item.id !== uploadId),
            );
          }
        }),
      );
    },
    [ensureFlashForFiles, showToast],
  );

  const toggleQuote = useCallback(
    (message: Message) => {
      if (streamingRef.current || message.status === 'streaming') return;
      setQuotedMessages((current) => {
        if (current.some((item) => item.id === message.id)) {
          return current.filter((item) => item.id !== message.id);
        }
        if (current.length >= 8) {
          showToast('最多引用 8 条消息', 'info');
          return current;
        }
        return [...current, message];
      });
    },
    [showToast],
  );

  const removeQuote = useCallback((messageId: number) => {

    setQuotedMessages((current) => current.filter((message) => message.id !== messageId));
  }, []);

  const selectSystemPrompt = useCallback(
    async (promptId: number | null) => {
      const conversationId = activeIdRef.current;
      if (conversationId && messagesRef.current.length > 0) {
        showToast('对话开始后不能修改系统提示词', 'info');
        return;
      }
      const previous = systemPromptId;
      setSystemPromptId(promptId);
      if (!conversationId) {
        const prompt = prompts.find((item) => item.id === promptId);
        setSystemPromptName(prompt?.name ?? '');
        setSystemPromptText(prompt?.content ?? '');
        return;
      }
      try {
        const { conversation } = await setConversationSettings(conversationId, {
          system_prompt_id: promptId,
        });
        setConversations((current) => upsertConversation(current, conversation));
        setSystemPromptName(conversation.system_prompt_name ?? '');
        setSystemPromptText(conversation.system_prompt_text ?? '');
      } catch (error) {
        setSystemPromptId(previous);
        showToast(
          error instanceof ApiError ? error.message : '设置系统提示词失败',
          'error',
        );
      }
    },
    [prompts, showToast, systemPromptId],
  );

  const toggleSingleTurn = useCallback(
    async (enabled: boolean) => {
      const conversationId = activeIdRef.current;
      if (conversationId && messagesRef.current.length > 0) {
        showToast('对话开始后不能切换单轮模式', 'info');
        return;
      }
      const previous = singleTurn;
      setSingleTurn(enabled);
      if (!conversationId) return;
      try {
        const { conversation } = await setConversationSettings(conversationId, {
          single_turn: enabled,
        });
        setConversations((current) => upsertConversation(current, conversation));
      } catch (error) {
        setSingleTurn(previous);
        showToast(
          error instanceof ApiError ? error.message : '设置单轮对话失败',
          'error',
        );
      }
    },
    [showToast, singleTurn],
  );

  const handlePromptsChanged = useCallback(
    (nextPrompts: SystemPrompt[]) => {
      setPrompts(nextPrompts);
      if (
        systemPromptId !== null &&
        !nextPrompts.some((prompt) => prompt.id === systemPromptId)
      ) {
        setSystemPromptId(null);
        if (messagesRef.current.length === 0) {
          setSystemPromptName('');
          setSystemPromptText('');
        }
      }
      if (
        prefs.defaultPromptId !== null &&
        !nextPrompts.some((prompt) => prompt.id === prefs.defaultPromptId)
      ) {
        updatePreferences({ defaultPromptId: null });
      }
    },
    [prefs.defaultPromptId, systemPromptId, updatePreferences],
  );

  const removeAttachment = useCallback(async (attachmentId: string) => {
    pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter(
      (item) => item.id !== attachmentId,
    );
    setPendingAttachments(pendingAttachmentsRef.current);
    try {
      await deleteAttachment(attachmentId);
    } catch {
      // 已发送或已清理的附件忽略
    }
  }, []);

  const refreshPrompts = useCallback(async (): Promise<SystemPrompt[]> => {
    try {
      const data = await listPrompts();
      setPrompts(data.prompts);
      return data.prompts;
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        showToast('加载提示词库失败', 'error');
      }
      return [];
    }
  }, [showToast]);

  const refreshConversations = useCallback(
    async (reset = false): Promise<Conversation[]> => {
      try {
        const loaded = reset
          ? prefs.searchStep
          : Math.max(prefs.searchStep, conversationsRef.current.length);
        const data = await listConversations(loaded, 0);
        setConversations(data.conversations);
        setHasMoreConversations(data.has_more);
        return data.conversations;
      } catch (error) {
        if (!(error instanceof ApiError && error.status === 401)) {
          // 轮询失败不打扰用户，下一次会重试
        }
        return [];
      }
    },
    [prefs.searchStep],
  );

  const loadMoreConversations = useCallback(async () => {
    if (loadingMoreConversations || !hasMoreConversations) return;
    setLoadingMoreConversations(true);
    try {
      const data = await listConversations(
        prefs.searchStep,
        conversationsRef.current.length,
      );
      setConversations((current) => {
        const known = new Set(current.map((conversation) => conversation.id));
        const merged = [
          ...current,
          ...data.conversations.filter((conversation) => !known.has(conversation.id)),
        ];
        conversationsRef.current = merged;
        return merged;
      });
      setHasMoreConversations(data.has_more);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) {
        showToast('加载更多对话失败', 'error');
      }
    } finally {
      setLoadingMoreConversations(false);
    }
  }, [hasMoreConversations, loadingMoreConversations, prefs.searchStep, showToast]);

  useEffect(() => {
    if (auth !== 'in') return;
    void refreshConversations(true);
    void refreshPrompts();
  }, [auth, prefs.searchStep, refreshConversations, refreshPrompts]);

  const applyDefaultNewChatSettings = useCallback(() => {
    const defaultPrompt =
      prefs.defaultPromptId !== null &&
      prompts.some((prompt) => prompt.id === prefs.defaultPromptId)
        ? prefs.defaultPromptId
        : null;
    setSystemPromptId(defaultPrompt);
    setSingleTurn(prefs.defaultSingleTurn);
  }, [prefs.defaultPromptId, prefs.defaultSingleTurn, prompts]);

  const clearConversation = useCallback(() => {
    discardPendingAttachments();
    loadTokenRef.current += 1;
    setLoadingConversation(false);
    setActiveId(null);
    activeIdRef.current = null;
    setMessages([]);
    messagesRef.current = [];
    setEditingMessage(null);
    setHighlightMessageId(null);
    setQuotedMessages([]);
    setSystemPromptId(null);
    setSystemPromptName('');
    setSystemPromptText('');
    setSingleTurn(false);
    localStorage.removeItem(LAST_KEY);
    syncUrl(null);
    setInput('');
  }, []);

  const openConversation = useCallback(
    async (
      conversationId: number,
      closeMobile = true,
      highlightId?: number,
      branchMessageId?: number,
    ) => {
      if (streamingRef.current) {
        showToast('请先停止当前生成', 'info');
        return;
      }
      discardPendingAttachments();
      const loadToken = ++loadTokenRef.current;
      setLoadingConversation(true);
      try {
        const data = branchMessageId
          ? await activateMessage(conversationId, branchMessageId)
          : await getConversation(conversationId);
        if (loadToken !== loadTokenRef.current) return;
        setActiveId(data.conversation.id);
        activeIdRef.current = data.conversation.id;
        setMessages(data.messages);
        messagesRef.current = data.messages;
        const hasAttachments = data.messages.some(
          (message) => (message.attachments?.length || 0) > 0,
        );
        const nextModel: Model =
          webSearch || hasAttachments
            ? 'deepseek-flash'
            : normalizeModel(data.conversation.model);
        setModel(nextModel);
        modelRef.current = nextModel;
        setSystemPromptId(data.conversation.system_prompt_id ?? null);
        setSystemPromptName(data.conversation.system_prompt_name ?? '');
        setSystemPromptText(data.conversation.system_prompt_text ?? '');
        setSingleTurn(Boolean(data.conversation.single_turn));
        setQuotedMessages([]);
        setEditingMessage(null);
        setInput('');
        setHighlightMessageId(highlightId ?? null);
        localStorage.setItem(LAST_KEY, String(data.conversation.id));
        syncUrl(data.conversation.id);
        setConversations((current) => upsertConversation(current, data.conversation));
        if (closeMobile) setSidebarOpen(false);
      } catch (error) {
        if (loadToken !== loadTokenRef.current) return;
        if (error instanceof ApiError && error.status === 404) {
          showToast('对话不存在或已被删除', 'error');
          clearConversation();
          void refreshConversations();
        } else {
          showToast('加载对话失败，请稍后重试', 'error');
        }
      } finally {
        if (loadToken === loadTokenRef.current) setLoadingConversation(false);
      }
    },
    [clearConversation, discardPendingAttachments, refreshConversations, showToast, webSearch],
  );

  const restoreLastConversation = useCallback(
    async (items: Conversation[]) => {
      const queryId = Number(new URLSearchParams(window.location.search).get('c'));
      const savedId = Number(localStorage.getItem(LAST_KEY));
      const wanted = Number.isFinite(queryId) && queryId > 0 ? queryId : savedId;
      const target = items.find((item) => item.id === wanted);
      if (target) {
        await openConversation(target.id, false);
      } else if (wanted > 0) {
        // 最近对话可能在分页之外，直接按 ID 打开；404 会走正常的清空逻辑。
        await openConversation(wanted, false);
      } else {
        clearConversation();
        applyDefaultNewChatSettings();
      }
    },
    [applyDefaultNewChatSettings, clearConversation, openConversation],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const session = await getSession();
        if (cancelled) return;
        if (!session.authenticated) {
          setAuth('out');
          return;
        }
        setAuth('in');
        const items = await refreshConversations();
        if (cancelled) return;
        await restoreLastConversation(items);
      } catch {
        if (!cancelled) setAuth('out');
      }
    })();
    return () => {
      cancelled = true;
    };
    // 只在首次挂载时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const handler = () => {
      abortRef.current?.abort();
      streamingRef.current = false;
      setStreaming(false);
      setAuth('out');
      setConversations([]);
      clearConversation();
      showToast('登录已过期，请重新登录', 'error');
    };
    window.addEventListener('dschat:unauthorized', handler);
    return () => window.removeEventListener('dschat:unauthorized', handler);
  }, [clearConversation, showToast]);

  // 当前会话的增量轮询：
  // - 空闲时 4 秒一次，用于发现另一台设备的新消息；
  // - 检测到流式消息时 1 秒一次，把小模型进度持续拉回来。
  useEffect(() => {
    if (auth !== 'in' || !activeId || streaming) return;
    let cancelled = false;
    let timer: number | undefined;

    const schedule = (delay: number) => {
      if (!cancelled) {
        timer = window.setTimeout(() => {
          void tick();
        }, delay);
      }
    };

    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState !== 'visible' || streamingRef.current) {
        schedule(4000);
        return;
      }

      try {
        const data = await getConversation(activeId);
        if (cancelled) return;
        setMessages((current) =>
          messagesEqual(current, data.messages) ? current : data.messages,
        );
        setConversations((current) => upsertConversation(current, data.conversation));
        setSystemPromptId(data.conversation.system_prompt_id ?? null);
        setSystemPromptName(data.conversation.system_prompt_name ?? '');
        setSystemPromptText(data.conversation.system_prompt_text ?? '');
        setSingleTurn(Boolean(data.conversation.single_turn));

        const stillStreaming = data.messages.some((message) => message.status === 'streaming');
        schedule(stillStreaming ? 1000 : 4000);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 404) {
          showToast('对话已在另一台设备删除', 'info');
          clearConversation();
          void refreshConversations();
          return;
        }
        schedule(4000);
      }
    };

    schedule(800);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [activeId, auth, clearConversation, refreshConversations, showToast, streaming]);

  useEffect(() => {
    if (auth !== 'in') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshConversations();
    }, 15000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshConversations();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [auth, refreshConversations]);

  const createHandlers = useCallback(
    (userTempId: number | null, assistantTempId: number): StreamHandlers => {
      let currentAssistantId = assistantTempId;
      return {
        onMeta(meta) {
          const conversation = meta.conversation;
          setActiveId(conversation.id);
          activeIdRef.current = conversation.id;
          setConversations((current) => upsertConversation(current, conversation));
          setModel(meta.model);
          modelRef.current = meta.model;
          setSystemPromptId(conversation.system_prompt_id ?? null);
          setSystemPromptName(conversation.system_prompt_name ?? '');
          setSystemPromptText(conversation.system_prompt_text ?? '');
          setSingleTurn(Boolean(conversation.single_turn));
          localStorage.setItem(LAST_KEY, String(conversation.id));
          syncUrl(conversation.id);

          currentAssistantId = meta.assistant_message.id;
          assistantIdRef.current = meta.assistant_message.id;
          setMessages((current) =>
            current.map((message) => {
              if (userTempId !== null && message.id === userTempId) {
                return meta.user_message || message;
              }
              if (message.id === assistantTempId) {
                return {
                  ...meta.assistant_message,
                  content: message.content,
                  reasoning: message.reasoning,
                  status: 'streaming',
                };
              }
              return message;
            }),
          );
        },
        onDelta(text) {
          setMessages((current) =>
            updateMessage(current, currentAssistantId, (message) => ({
              ...message,
              content: message.content + text,
              searching: false,
              status: 'streaming',
            })),
          );
        },
        onReasoning(text) {
          setMessages((current) =>
            updateMessage(current, currentAssistantId, (message) => ({
              ...message,
              reasoning: message.reasoning + text,
              searching: false,
              status: 'streaming',
            })),
          );
        },
        onSearch() {
          setMessages((current) =>
            updateMessage(current, currentAssistantId, (message) => ({
              ...message,
              searching: true,
            })),
          );
        },
        onSources(sources) {
          setMessages((current) =>
            updateMessage(current, currentAssistantId, (message) => ({
              ...message,
              sources,
            })),
          );
        },
        onDone(done) {
          if (done.message) {
            setMessages((current) =>
              replaceMessage(current, currentAssistantId, done.message as Message),
            );
          } else {
            setMessages((current) =>
              updateMessage(current, currentAssistantId, (message) => ({
                ...message,
                status: 'interrupted',
              })),
            );
          }
          setStreaming(false);
          streamingRef.current = false;
          abortRef.current = null;
          const conversationId = activeIdRef.current;
          if (conversationId) void reloadActiveConversation(conversationId);
          void refreshConversations();
        },
        onError(error) {
          setMessages((current) =>
            updateMessage(current, currentAssistantId, (message) => ({
              ...message,
              content: error.message_data?.content ?? message.content,
              reasoning: error.message_data?.reasoning ?? message.reasoning,
              searching: false,
              status: 'error',
              error: error.message,
            })),
          );
          setStreaming(false);
          streamingRef.current = false;
          abortRef.current = null;
          showToast(error.message, 'error');
          void refreshConversations();
        },
      };
    },
    [refreshConversations, reloadActiveConversation, showToast],
  );

  const startEdit = useCallback((message: Message) => {
    if (
      message.role !== 'user' ||
      streamingRef.current ||
      messagesRef.current.some((item) => item.status === 'streaming')
    ) {
      return;
    }
    setEditingMessage(message);
    setInput(message.content);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingMessage(null);
    setInput('');
  }, []);

  const send = useCallback(async () => {
    const content = input.trim();
    if (streamingRef.current || auth !== 'in' || loadingConversation) return;
    if (!content && pendingAttachments.length === 0) {
      if (quotedMessages.length > 0) {
        showToast('引用不能单独发送，请同时输入问题或添加附件', 'info');
      }
      return;
    }
    if (messagesRef.current.some((message) => message.status === 'streaming')) {
      showToast('对方正在生成回复，请稍候', 'info');
      return;
    }
    if (uploadingFiles.length > 0) {
      showToast('附件还在上传/解析，请稍候', 'info');
      return;
    }

    const editing = editingMessage;
    if (editing && !content) {
      showToast('编辑消息不能为空', 'info');
      return;
    }
    const conversationId = activeIdRef.current;
    if (editing && !conversationId) {
      cancelEdit();
      return;
    }
    if (editing && !messagesRef.current.some((message) => message.id === editing.id)) {
      showToast('要编辑的消息已不存在', 'info');
      cancelEdit();
      return;
    }

    const targetConversationId = conversationId ?? 0;
    const attachmentIds = pendingAttachments.map((attachment) => attachment.id);
    const quotedMessageIds = quotedMessages.map((message) => message.id);
    const quoteSnapshots = quotedMessages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
    }));
    const userTemp = editing ? null : makeTempMessage(targetConversationId, 'user', content);
    if (userTemp) {
      userTemp.attachments = pendingAttachments;
      userTemp.quotes = quoteSnapshots;
    }
    const assistantTemp = makeTempMessage(targetConversationId, 'assistant', '');
    assistantTemp.web_search = webSearch;
    assistantTemp.thinking = deepThinking;
    const assistantTempId = assistantTemp.id;

    if (editing) {
      setMessages((current) => {
        const index = current.findIndex((message) => message.id === editing.id);
        if (index < 0) return [...current, assistantTemp];
        const next = current.slice(0, index + 1).map((message) =>
          message.id === editing.id
            ? { ...message, content, updated_at: Date.now() }
            : message,
        );
        return [...next, assistantTemp];
      });
    } else {
      setMessages((current) => [...current, userTemp as Message, assistantTemp]);
    }

    setEditingMessage(null);
    setInput('');
    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
    setQuotedMessages([]);
    setStreaming(true);
    streamingRef.current = true;
    stoppedRef.current = false;
    assistantIdRef.current = assistantTempId;

    const controller = new AbortController();
    abortRef.current = controller;
    const handlers = createHandlers(editing ? editing.id : (userTemp as Message).id, assistantTempId);

    try {
      if (editing) {
        await editMessageRequest(
          editing.conversation_id,
          editing.id,
          content,
          modelRef.current,
          webSearch,
          deepThinking,
          attachmentIds,
          quotedMessageIds,
          handlers,
          controller.signal,
        );
      } else {
        await streamChat(
          conversationId,
          content,
          modelRef.current,
          webSearch,
          deepThinking,
          attachmentIds,
          systemPromptId,
          singleTurn,
          quotedMessageIds,
          handlers,
          controller.signal,
        );
      }
    } catch (error) {
      if (controller.signal.aborted || stoppedRef.current) {
        setMessages((current) =>
          updateMessage(current, assistantIdRef.current, (message) => ({
            ...message,
            status: 'stopped',
          })),
        );
      } else {
        const message = error instanceof ApiError ? error.message : '发送失败，请稍后重试';
        setMessages((current) =>
          updateMessage(current, assistantIdRef.current, (assistant) => ({
            ...assistant,
            status: 'error',
            error: message,
          })),
        );
        showToast(message, 'error');
      }
    } finally {
      setStreaming(false);
      streamingRef.current = false;
      abortRef.current = null;
      void refreshConversations();
    }
  }, [
    auth,
    cancelEdit,
    createHandlers,
    deepThinking,
    editingMessage,
    input,
    loadingConversation,
    pendingAttachments,
    quotedMessages,
    refreshConversations,
    singleTurn,
    showToast,
    systemPromptId,
    uploadingFiles.length,
    webSearch,
  ]);

  const stop = useCallback(() => {
    const localStreaming = streamingRef.current;
    const remoteStreaming = messagesRef.current.some((message) => message.status === 'streaming');
    if (!localStreaming && !remoteStreaming) return;

    const conversationId = activeIdRef.current;
    if (localStreaming) {
      stoppedRef.current = true;
      abortRef.current?.abort();
    }
    if (conversationId) {
      void stopConversation(conversationId).catch(() => undefined);
    }

    // 不管停的是本机还是另一台设备的流，先更新本地界面；
    // 服务端保存后的最终状态会在下一次轮询时覆盖。
    setMessages((current) =>
      current.map((message) =>
        message.status === 'streaming'
          ? { ...message, searching: false, status: 'stopped' }
          : message,
      ),
    );
    setStreaming(false);
    streamingRef.current = false;
  }, []);

  const regenerate = useCallback(async () => {
    const conversationId = activeIdRef.current;
    if (!conversationId || streamingRef.current) return;
    if (messagesRef.current.some((message) => message.status === 'streaming')) {
      showToast('正在生成回复，请先停止', 'info');
      return;
    }

    const lastAssistant = [...messagesRef.current].reverse().find((message) => message.role === 'assistant');
    if (!lastAssistant) return;

    setMessages((current) => current.filter((message) => message.id !== lastAssistant.id));
    const tempId = -Date.now();
    const placeholder = makeTempMessage(conversationId, 'assistant', '');
    placeholder.id = tempId;
    placeholder.web_search = webSearch;
    placeholder.thinking = deepThinking;
    setMessages((current) => [...current, placeholder]);
    setStreaming(true);
    streamingRef.current = true;
    stoppedRef.current = false;
    assistantIdRef.current = tempId;

    const controller = new AbortController();
    abortRef.current = controller;
    const handlers = createHandlers(null, tempId);

    try {
      await regenerateRequest(
        conversationId,
        modelRef.current,
        webSearch,
        deepThinking,
        handlers,
        controller.signal,
      );
    } catch (error) {
      if (controller.signal.aborted || stoppedRef.current) {
        setMessages((current) =>
          updateMessage(current, assistantIdRef.current, (message) => ({
            ...message,
            status: 'stopped',
          })),
        );
      } else {
        const message = error instanceof ApiError ? error.message : '重新生成失败，请稍后重试';
        setMessages((current) =>
          updateMessage(current, assistantIdRef.current, (assistant) => ({
            ...assistant,
            status: 'error',
            error: message,
          })),
        );
        showToast(message, 'error');
      }
    } finally {
      setStreaming(false);
      streamingRef.current = false;
      abortRef.current = null;
      void refreshConversations();
    }
  }, [createHandlers, deepThinking, refreshConversations, showToast, webSearch]);

  const newChat = useCallback(() => {
    if (streamingRef.current) {
      showToast('请先停止当前生成', 'info');
      return;
    }
    clearConversation();
    applyDefaultNewChatSettings();
    setSidebarOpen(false);
  }, [applyDefaultNewChatSettings, clearConversation, showToast]);

  const selectConversation = useCallback(
    (conversationId: number) => {
      if (conversationId === activeIdRef.current) {
        setSidebarOpen(false);
        return;
      }
      void openConversation(conversationId);
    },
    [openConversation],
  );

  const changeModel = useCallback(
    (nextModel: Model) => {
      const hasFiles =
        pendingAttachmentsRef.current.length > 0 ||
        messagesRef.current.some((message) => (message.attachments?.length || 0) > 0);
      if (hasFiles && nextModel !== 'deepseek-flash') {
        showToast('包含附件的对话需要使用 DeepSeek V4.1 Flash', 'info');
        return;
      }
      if (webSearch && nextModel !== 'deepseek-flash') {
        showToast('联网搜索需要使用 DeepSeek V4.1 Flash', 'info');
        return;
      }
      setModel(nextModel);
      modelRef.current = nextModel;
      const conversationId = activeIdRef.current;
      if (conversationId) {
        void setConversationModel(conversationId, nextModel)
          .then(({ conversation }) => {
            setConversations((current) => upsertConversation(current, conversation));
          })
          .catch(() => undefined);
      }
    },
    [showToast, webSearch],
  );

  const toggleWebSearch = useCallback(
    (enabled: boolean) => {
      setWebSearch(enabled);
      if (!enabled) return;
      if (modelRef.current !== 'deepseek-flash') {
        setModel('deepseek-flash');
        modelRef.current = 'deepseek-flash';
        const conversationId = activeIdRef.current;
        if (conversationId) {
          void setConversationModel(conversationId, 'deepseek-flash')
            .then(({ conversation }) => {
              setConversations((current) => upsertConversation(current, conversation));
            })
            .catch(() => undefined);
        }
        showToast('联网搜索已开启，已切换到 DeepSeek V4.1 Flash', 'info');
      }
    },
    [showToast],
  );

  const toggleDeepThinking = useCallback((enabled: boolean) => {
    setDeepThinking(enabled);
  }, []);

  const handleSearchSelect = useCallback(
    (result: SearchResult) => {
      setSearchOpen(false);
      setSidebarOpen(false);
      if (!result.message_id) {
        if (result.conversation_id !== activeIdRef.current) {
          void openConversation(result.conversation_id, true);
        }
        return;
      }
      // 命中的消息可能在被折叠的旧分支里：先激活该分支，再定位高亮。
      void openConversation(
        result.conversation_id,
        true,
        result.message_id,
        result.message_id,
      );
    },
    [openConversation],
  );

  const copyText = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast('已复制到剪贴板', 'success');
      } catch {
        showToast('复制失败，请手动选择文本', 'error');
      }
    },
    [showToast],
  );

  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const title = renameValue.trim();
    if (!title) return;
    try {
      const { conversation } = await renameConversation(renameTarget.id, title);
      setConversations((current) => upsertConversation(current, conversation));
      setRenameTarget(null);
      showToast('已重命名', 'success');
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : '重命名失败', 'error');
    }
  }, [renameTarget, renameValue, showToast]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    if (deleteTarget.id === activeIdRef.current && streamingRef.current) {
      showToast('正在生成的对话不能删除，请先停止', 'info');
      setDeleteTarget(null);
      return;
    }
    try {
      await deleteConversation(deleteTarget.id);
      setConversations((current) => current.filter((item) => item.id !== deleteTarget.id));
      if (deleteTarget.id === activeIdRef.current) clearConversation();
      setDeleteTarget(null);
      showToast('对话已删除', 'success');
    } catch (error) {
      showToast(error instanceof ApiError ? error.message : '删除失败', 'error');
    }
  }, [clearConversation, deleteTarget, showToast]);

  const handleLogout = useCallback(async () => {
    if (streamingRef.current) stop();
    try {
      await logout();
    } catch {
      // 即使请求失败也清掉本地状态
    }
    setAuth('out');
    setConversations([]);
    clearConversation();
    abortRef.current?.abort();
    setStreaming(false);
    streamingRef.current = false;
    showToast('已退出登录', 'success');
  }, [clearConversation, showToast, stop]);

  const handleLogin = useCallback(
    async (password: string) => {
      await login(password);
      setAuth('in');
      const items = await refreshConversations();
      await restoreLastConversation(items);
    },
    [refreshConversations, restoreLastConversation],
  );

  const handleSuggestion = useCallback((prompt: string) => {
    setInput(prompt);
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus();
    });
  }, []);

  if (auth === 'loading') {
    return (
      <div className="boot-screen">
        <Logo size={52} />
        <Loader2 size={20} className="spin" />
      </div>
    );
  }

  if (auth === 'out') {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
      <Sidebar
        conversations={conversations}
        activeId={activeId}
        open={sidebarOpen}
        hasMore={hasMoreConversations}
        loadingMore={loadingMoreConversations}
        onClose={closeSidebar}
        onNew={newChat}
        onSearch={() => setSearchOpen(true)}
        onLoadMore={() => void loadMoreConversations()}
        onSelect={selectConversation}
        onRename={(conversation) => {
          setRenameTarget(conversation);
          setRenameValue(conversation.title);
        }}
        onDelete={setDeleteTarget}
        onSettings={() => setSettingsOpen(true)}
        onLogout={handleLogout}
      />
      {sidebarOpen && (
        <button
          type="button"
          className="sidebar-overlay"
          onClick={closeSidebar}
          aria-label="关闭侧边栏"
        />
      )}

      <main className="main-panel">
        {loadingConversation && <div className="loading-bar" aria-label="正在加载对话" />}
        <ChatView
          conversationId={activeId ?? 0}
          title={title}
          messages={messages}
          model={model}
          streaming={isGenerating}
          systemPromptId={systemPromptId}
          systemPromptName={systemPromptName}
          systemPromptText={systemPromptText}
          singleTurn={singleTurn}
          prompts={prompts}
          quotedMessageIds={quotedMessages.map((message) => message.id)}
          showTokenUsage={prefs.showTokenUsage}
          showAssistantIdentity={prefs.showAssistantIdentity}
          showChatTitle={prefs.showChatTitle}
          showSystemPromptMessage={prefs.showSystemPromptMessage}
          onOpenSidebar={openSidebar}
          onModelChange={changeModel}
          onRegenerate={() => void regenerate()}
          onCopy={(text) => void copyText(text)}
          onSuggestion={handleSuggestion}
          onEdit={startEdit}
          onSwitchVersion={(messageId) => void switchVersion(messageId)}
          onToggleQuote={toggleQuote}
          onSelectPrompt={(promptId) => void selectSystemPrompt(promptId)}
          onToggleSingleTurn={(enabled) => void toggleSingleTurn(enabled)}
          onManagePrompts={() => {
            setPromptLibraryOpen(true);
            void refreshPrompts();
          }}
          highlightMessageId={highlightMessageId}
        />
        <Composer
          value={input}
          onChange={setInput}
          onSend={() => void send()}
          onStop={stop}
          streaming={isGenerating}
          disabled={loadingConversation}
          editing={Boolean(editingMessage)}
          onCancelEdit={cancelEdit}
          webSearch={webSearch}
          onToggleWebSearch={toggleWebSearch}
          deepThinking={deepThinking}
          onToggleDeepThinking={toggleDeepThinking}
          attachments={pendingAttachments}
          uploadingFiles={uploadingFiles}
          quotedMessages={quotedMessages}
          onAddFiles={(files) => void handleFiles(files)}
          onRemoveAttachment={(id) => void removeAttachment(id)}
          onRemoveQuote={removeQuote}
          maxAttachments={MAX_ATTACHMENTS}
        />
      </main>

      <Modal
        open={Boolean(renameTarget)}
        title="重命名对话"
        onClose={() => setRenameTarget(null)}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setRenameTarget(null)}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={() => void submitRename()}>
              保存
            </button>
          </>
        }
      >
        <input
          className="text-input"
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitRename();
          }}
          maxLength={120}
          autoFocus
          placeholder="对话名称"
        />
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        title="删除对话"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <button type="button" className="btn ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </button>
            <button type="button" className="btn danger" onClick={() => void confirmDelete()}>
              删除
            </button>
          </>
        }
      >
        <p className="modal-text">
          确定删除「{deleteTarget?.title}」吗？删除后无法恢复。
        </p>
      </Modal>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        theme={theme}
        onThemeChange={(dark) => setTheme(dark ? 'dark' : 'light')}
        darkLock={darkLock}
        onDarkLockChange={toggleDarkLock}
        preferences={prefs}
        onPreferencesChange={updatePreferences}
        prompts={prompts}
        onManagePrompts={() => {
          setSettingsOpen(false);
          setPromptLibraryOpen(true);
          void refreshPrompts();
        }}
        onLogout={handleLogout}
      />

      <PromptLibrary
        open={promptLibraryOpen}
        prompts={prompts}
        onClose={() => setPromptLibraryOpen(false)}
        onPromptsChanged={handlePromptsChanged}
        onError={(message) => showToast(message, 'error')}
      />

      <SearchDialog
        open={searchOpen}
        step={prefs.searchStep}
        onClose={() => setSearchOpen(false)}
        onSelect={handleSearchSelect}
      />

      <ToastViewport
        toasts={toasts}
        onDismiss={(id) => setToasts((current) => current.filter((toast) => toast.id !== id))}
      />
    </div>
  );
}
