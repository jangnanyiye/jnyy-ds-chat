import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  Brain,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  FileText,
  Globe,
  Lightbulb,
  ListTree,
  Loader2,
  PanelLeft,
  PanelRightClose,
  Pencil,
  RefreshCw,
  Send,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';
import removeMarkdown from 'remove-markdown';
import type { Attachment, Message, Model, Source } from '../types';
import { formatBytes, formatTokens } from '../lib/format';
import { Logo } from './Logo';
import { ModelPicker } from './ModelPicker';

const Markdown = lazy(async () => {
  const module = await import('./Markdown');
  return { default: module.Markdown };
});

const suggestions = [
  {
    icon: Wand2,
    title: '写一段自我介绍',
    prompt: '帮我写一段简洁、自然的自我介绍，适合用在社交场合。',
  },
  {
    icon: Terminal,
    title: '用 Python 实现快速排序',
    prompt: '用 Python 实现快速排序，并解释时间复杂度和边界情况。',
  },
  {
    icon: Lightbulb,
    title: '解释量子纠缠',
    prompt: '用通俗易懂的方式解释量子纠缠，举一个生活中的类比。',
  },
  {
    icon: Sparkles,
    title: '制定一周学习计划',
    prompt: '帮我制定一个一周的编程学习计划，每天 1-2 小时。',
  },
];

function ReasoningBlock({ content, streaming }: { content: string; streaming: boolean }) {
  const [open, setOpen] = useState(streaming);
  const previous = useRef(streaming);

  useEffect(() => {
    if (previous.current !== streaming) {
      setOpen(streaming);
      previous.current = streaming;
    }
  }, [streaming]);

  if (!content) return null;

  return (
    <div className={`reasoning ${open ? 'open' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((value) => !value)}>
        <Brain size={15} />
        <span>{streaming ? '正在深度思考…' : '已深度思考'}</span>
        {streaming && <Loader2 size={13} className="spin" />}
        <ChevronRight size={14} className={open ? 'rotated' : ''} />
      </button>
      {open && <div className="reasoning-body">{content}</div>}
    </div>
  );
}

function sourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function Sources({ sources }: { sources?: Source[] }) {
  if (!sources?.length) return null;
  return (
    <div className="sources">
      <div className="sources-head">
        <Globe size={13} />
        <span>参考来源</span>
      </div>
      <div className="sources-list">
        {sources.slice(0, 6).map((source, index) => (
          <a
            key={`${source.url}-${index}`}
            className="source-card"
            href={source.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            <span className="source-index">{index + 1}</span>
            <span className="source-copy">
              <strong>{source.title || sourceHost(source.url)}</strong>
              <small>{source.site_name || sourceHost(source.url)}</small>
            </span>
            <ExternalLink size={12} className="source-open" />
          </a>
        ))}
      </div>
    </div>
  );
}

function BranchSwitcher({
  message,
  disabled,
  onSwitch,
}: {
  message: Message;
  disabled: boolean;
  onSwitch: (messageId: number) => void;
}) {
  const ids = message.version_ids || [];
  const index = message.version_index || 1;
  if (ids.length <= 1) return null;

  return (
    <div className="branch-switcher" aria-label="消息版本">
      <button
        type="button"
        disabled={disabled || index <= 1}
        onClick={() => onSwitch(ids[index - 2])}
        aria-label="上一版本"
      >
        <ChevronLeft size={13} />
      </button>
      <span>
        {index}/{ids.length}
      </span>
      <button
        type="button"
        disabled={disabled || index >= ids.length}
        onClick={() => onSwitch(ids[index])}
        aria-label="下一版本"
      >
        <ChevronRight size={13} />
      </button>
    </div>
  );
}

function MessageAttachments({ attachments }: { attachments?: Attachment[] }) {
  if (!attachments?.length) return null;
  return (
    <div className="user-attachments">
      {attachments.map((attachment) =>
        attachment.kind === 'image' ? (
          <a
            key={attachment.id}
            className="user-attachment image"
            href={attachment.url}
            target="_blank"
            rel="noreferrer noopener"
            title={attachment.filename}
          >
            <img src={attachment.url} alt={attachment.filename} loading="lazy" />
          </a>
        ) : (
          <a
            key={attachment.id}
            className="user-attachment file"
            href={attachment.url}
            target="_blank"
            rel="noreferrer noopener"
            title={attachment.filename}
          >
            <span className="user-attachment-icon">
              <FileText size={16} />
            </span>
            <span className="user-attachment-copy">
              <strong>{attachment.filename}</strong>
              <small>{formatBytes(attachment.size)}</small>
            </span>
          </a>
        ),
      )}
    </div>
  );
}

function MessageItem({
  message,
  isLast,
  canRegenerate,
  streaming,
  onCopy,
  onRegenerate,
  onEdit,
  onSwitchVersion,
  highlighted,
}: {
  message: Message;
  isLast: boolean;
  canRegenerate: boolean;
  streaming: boolean;
  onCopy: (text: string) => void;
  onRegenerate: () => void;
  onEdit: (message: Message) => void;
  onSwitchVersion: (messageId: number) => void;
  highlighted: boolean;
}) {
  const [copied, setCopied] = useState<'raw' | 'plain' | null>(null);
  const isAssistant = message.role === 'assistant';

  const markCopied = (kind: 'raw' | 'plain') => {
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 1400);
  };

  const copy = () => {
    onCopy(message.content);
    markCopied('raw');
  };

  const copyPlain = () => {
    const plain = removeMarkdown(message.content);
    onCopy(plain);
    markCopied('plain');
  };

  if (!isAssistant) {
    return (
      <div
        className={`message user ${highlighted ? 'highlight' : ''}`}
        data-message-id={message.id}
      >
        <div className="user-content">
          <MessageAttachments attachments={message.attachments} />
          <div className="user-bubble">{message.content}</div>
          <BranchSwitcher message={message} disabled={streaming} onSwitch={onSwitchVersion} />
          {!streaming && (
            <div className="message-actions user-actions">
              <button type="button" onClick={copy} aria-label="复制用户消息">
                {copied === 'raw' ? <Check size={14} /> : <Copy size={14} />}
                <span>{copied === 'raw' ? '已复制' : '复制'}</span>
              </button>
              <button type="button" onClick={() => onEdit(message)} aria-label="编辑用户消息">
                <Pencil size={14} />
                <span>编辑</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  const hasUsage =
    message.prompt_tokens != null ||
    message.completion_tokens != null ||
    message.reasoning_tokens != null;
  const totalTokens = (message.prompt_tokens || 0) + (message.completion_tokens || 0);

  return (
    <div
      className={`message assistant ${highlighted ? 'highlight' : ''}`}
      data-message-id={message.id}
    >
      <div className="assistant-avatar">
        <Logo size={26} />
      </div>
      <div className="assistant-body">
        <div className="assistant-name">
          <span>DeepSeek</span>
          {message.web_search && (
            <span className="web-badge">
              <Globe size={10} />
              联网
            </span>
          )}
          {message.thinking && (
            <span className="web-badge thinking-badge">
              <Brain size={10} />
              思考
            </span>
          )}
        </div>
        {message.searching && message.status === 'streaming' && (
          <div className="searching-chip">
            <Loader2 size={13} className="spin" />
            正在联网搜索…
          </div>
        )}
        <ReasoningBlock
          content={message.reasoning}
          streaming={message.status === 'streaming' && !message.content}
        />

        {message.content ? (
          <>
            <Suspense fallback={<div className="markdown markdown-fallback">{message.content}</div>}>
              <Markdown content={message.content} />
            </Suspense>
            {message.status === 'streaming' && <span className="stream-cursor" />}
          </>
        ) : message.status === 'streaming' ? (
          <div className="typing-dots" aria-label="正在生成">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {message.status === 'error' && (
          <div className="message-error">
            <AlertTriangle size={15} />
            <span>{message.error || '生成失败，请重试'}</span>
          </div>
        )}
        {message.status === 'stopped' && <div className="message-note">已停止生成</div>}
        {message.status === 'interrupted' && <div className="message-note">生成已中断</div>}

        {message.content && message.status !== 'streaming' && (
          <div className="message-actions">
            <button type="button" onClick={copy} aria-label="复制原始 Markdown" title="复制原始 Markdown">
              {copied === 'raw' ? <Check size={14} /> : <Copy size={14} />}
              <span>{copied === 'raw' ? '已复制' : '复制'}</span>
            </button>
            <button type="button" onClick={copyPlain} aria-label="复制纯文本" title="去除 Markdown 元素后复制">
              {copied === 'plain' ? <Check size={14} /> : <FileText size={14} />}
              <span>{copied === 'plain' ? '已复制' : '纯文本'}</span>
            </button>
            {isLast && canRegenerate && !streaming && (
              <button type="button" onClick={onRegenerate} aria-label="重新生成">
                <RefreshCw size={14} />
                <span>重新生成</span>
              </button>
            )}
          </div>
        )}

        {hasUsage && (
          <div className="token-usage" title={`本轮共 ${totalTokens} tokens`}>
            <span>本轮</span>
            {message.prompt_tokens != null && <span>输入 {formatTokens(message.prompt_tokens)}</span>}
            {message.completion_tokens != null && (
              <span>输出 {formatTokens(message.completion_tokens)}</span>
            )}
            {message.reasoning_tokens != null && message.reasoning_tokens > 0 && (
              <span>推理 {formatTokens(message.reasoning_tokens)}</span>
            )}
            {message.cached_tokens != null && message.cached_tokens > 0 && (
              <span>缓存 {formatTokens(message.cached_tokens)}</span>
            )}
            <span className="token-usage-total">共 {formatTokens(totalTokens)}</span>
          </div>
        )}

        <Sources sources={message.sources} />

        <BranchSwitcher message={message} disabled={streaming} onSwitch={onSwitchVersion} />
      </div>
    </div>
  );
}

export function ChatView({
  conversationId,
  title,
  messages,
  model,
  streaming,
  onOpenSidebar,
  onModelChange,
  onRegenerate,
  onCopy,
  onSuggestion,
  onEdit,
  onSwitchVersion,
  highlightMessageId,
}: {
  conversationId: number;
  title: string;
  messages: Message[];
  model: Model;
  streaming: boolean;
  onOpenSidebar: () => void;
  onModelChange: (model: Model) => void;
  onRegenerate: () => void;
  onCopy: (text: string) => void;
  onSuggestion: (text: string) => void;
  onEdit: (message: Message) => void;
  onSwitchVersion: (messageId: number) => void;
  highlightMessageId: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const lastHighlightRef = useRef<number | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<number | null>(null);
  const [nearBottom, setNearBottom] = useState(true);
  const [indexExpanded, setIndexExpanded] = useState(false);
  const [activeIndexId, setActiveIndexId] = useState<number | null>(null);
  const lastAssistantId = [...messages].reverse().find((message) => message.role === 'assistant')?.id;
  const userMessages = messages.filter((message) => message.role === 'user' && message.content);
  const totalPrompt = messages.reduce((sum, message) => sum + (message.prompt_tokens || 0), 0);
  const totalCompletion = messages.reduce(
    (sum, message) => sum + (message.completion_tokens || 0),
    0,
  );
  const totalTokens = totalPrompt + totalCompletion;

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    const element = scrollRef.current;
    if (!element) return;
    stickToBottomRef.current = true;
    element.scrollTo({ top: element.scrollHeight, behavior });
  };

  const updateActiveIndex = () => {
    const element = scrollRef.current;
    if (!element) return;
    const items = Array.from(element.querySelectorAll<HTMLElement>('.message.user'));
    if (!items.length) {
      setActiveIndexId(null);
      return;
    }
    const threshold = element.getBoundingClientRect().top + 90;
    let active = items[0];
    for (const item of items) {
      if (item.getBoundingClientRect().top <= threshold) active = item;
    }
    const id = Number(active.dataset.messageId);
    if (Number.isFinite(id)) setActiveIndexId(id);
  };

  const jumpToIndex = (messageId: number) => {
    const element = scrollRef.current;
    if (!element) return;
    const target = element.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
    if (!target) return;
    const delta = target.getBoundingClientRect().top - element.getBoundingClientRect().top;
    stickToBottomRef.current = false;
    element.scrollTo({ top: element.scrollTop + delta - 24, behavior: 'smooth' });
    setActiveIndexId(messageId);
  };

  // 只有用户本来就在底部时才跟随新内容。
  // 不能把 nearBottom 放进依赖：用户往下滑越过阈值时会被误判成“需要贴底”，从而突然跳到底部。
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, streaming]);

  useEffect(() => {
    stickToBottomRef.current = true;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
    setNearBottom(true);
    lastHighlightRef.current = null;
    setActiveHighlight(null);
  }, [conversationId]);

  useEffect(() => {
    if (!highlightMessageId) return;
    if (lastHighlightRef.current === highlightMessageId) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-message-id="${highlightMessageId}"]`,
    );
    if (!element) return;
    lastHighlightRef.current = highlightMessageId;
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setActiveHighlight(highlightMessageId);
  }, [highlightMessageId, messages]);

  useEffect(() => {
    if (activeHighlight === null) return;
    const timer = window.setTimeout(() => setActiveHighlight(null), 2400);
    return () => window.clearTimeout(timer);
  }, [activeHighlight]);

  // 用原生监听而不是 React onScroll，确保程序化滚动和用户滚动都会更新“是否贴底”。
  // 只有真正贴底（12px 内）才继续跟随；距离底部 100px 时不应该被新一轮轮询拉回底部。
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const handleScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      stickToBottomRef.current = distance < 12;
      setNearBottom(distance < 140);
      updateActiveIndex();
    };
    element.addEventListener('scroll', handleScroll, { passive: true });
    handleScroll();
    return () => element.removeEventListener('scroll', handleScroll);
    // updateActiveIndex 每次从 DOM 读取，不需要重新绑定监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(updateActiveIndex);
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages]);

  return (
    <div className={`chat-view ${indexExpanded ? 'index-open' : ''}`}>
      <header className="chat-header">
        <button type="button" className="icon-btn mobile-menu" onClick={onOpenSidebar} aria-label="打开侧边栏">
          <PanelLeft size={20} />
        </button>
        <div className="chat-title">
          <h1>{title}</h1>
          <span title={`输入 ${totalPrompt} tokens · 输出 ${totalCompletion} tokens`}>
            本对话共 {formatTokens(totalTokens)} tokens
            {streaming ? ' · 正在生成…' : ''}
          </span>
        </div>
        <ModelPicker model={model} disabled={streaming} onChange={onModelChange} />
      </header>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="welcome">
            <div className="welcome-logo">
              <Logo size={58} />
            </div>
            <h2>我是 DeepSeek，很高兴见到你！</h2>
            <p>可以问我任何问题，或者从下面的建议开始。</p>
            <div className="suggestion-grid">
              {suggestions.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    type="button"
                    key={item.title}
                    className="suggestion-card"
                    onClick={() => onSuggestion(item.prompt)}
                  >
                    <Icon size={17} />
                    <span>{item.title}</span>
                    <Send size={13} className="suggestion-send" />
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="message-list">
            {messages.map((message, index) => (
              <MessageItem
                key={message.id}
                message={message}
                isLast={index === messages.length - 1}
                canRegenerate={message.id === lastAssistantId}
                streaming={streaming}
                onCopy={onCopy}
                onRegenerate={onRegenerate}
                onEdit={onEdit}
                onSwitchVersion={onSwitchVersion}
                highlighted={activeHighlight === message.id}
              />
            ))}
            <div className="message-list-tail" />
          </div>
        )}
      </div>

      {!nearBottom && (
        <button type="button" className="scroll-bottom" onClick={() => scrollToBottom()} aria-label="回到底部">
          <ArrowDown size={17} />
        </button>
      )}

      {userMessages.length > 0 && (
        <>
          <div className={`conversation-rail ${indexExpanded ? 'hidden' : ''}`} aria-label="对话索引">
            <button
              type="button"
              className="rail-open"
              onClick={() => setIndexExpanded(true)}
              title="展开对话索引"
              aria-label="展开对话索引"
            >
              <ListTree size={15} />
            </button>
            {userMessages.map((message, index) => (
              <button
                type="button"
                key={message.id}
                className={`rail-item ${activeIndexId === message.id ? 'active' : ''}`}
                onClick={() => jumpToIndex(message.id)}
                title={message.content.replace(/\s+/g, ' ').slice(0, 80)}
                aria-label={`跳到第 ${index + 1} 个问题`}
              >
                {index + 1}
              </button>
            ))}
          </div>

          {indexExpanded && (
            <div className="conversation-index">
              <div className="index-head">
                <span>
                  <ListTree size={15} />
                  对话索引
                </span>
                <button
                  type="button"
                  className="icon-btn"
                  onClick={() => setIndexExpanded(false)}
                  aria-label="收起对话索引"
                >
                  <PanelRightClose size={16} />
                </button>
              </div>
              <div className="index-list">
                {userMessages.map((message, index) => (
                  <button
                    type="button"
                    key={message.id}
                    className={`index-item ${activeIndexId === message.id ? 'active' : ''}`}
                    onClick={() => jumpToIndex(message.id)}
                  >
                    <span className="index-number">{index + 1}</span>
                    <span className="index-text">
                      {message.content.replace(/\s+/g, ' ').slice(0, 120)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
