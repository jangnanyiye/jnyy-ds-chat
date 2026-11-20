import { useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquare, Search, User, X } from 'lucide-react';
import { searchGlobal } from '../lib/api';
import { formatRelative } from '../lib/format';
import type { SearchResult } from '../types';

export function SearchDialog({
  open,
  onClose,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  onSelect: (result: SearchResult) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
      setSelectedIndex(0);
      return;
    }
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const keyword = query.trim();
    if (!keyword) {
      setResults([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const timer = window.setTimeout(async () => {
      try {
        const data = await searchGlobal(keyword);
        if (cancelled) return;
        setResults(data.results);
        setSelectedIndex(0);
      } catch {
        if (!cancelled) setResults([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 240);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  const choose = (result: SearchResult) => {
    onSelect(result);
  };

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((index) => Math.min(index + 1, Math.max(0, results.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter' && results[selectedIndex]) {
      event.preventDefault();
      choose(results[selectedIndex]);
    }
  };

  return (
    <div
      className="search-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div className="search-panel" role="dialog" aria-modal="true" aria-label="搜索对话">
        <div className="search-input-row">
          <Search size={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="搜索会话标题或消息内容…"
            maxLength={100}
            aria-label="搜索对话"
          />
          {loading && <Loader2 size={16} className="spin" />}
          <button type="button" className="search-close" onClick={onClose} aria-label="关闭搜索">
            <X size={18} />
          </button>
        </div>

        <div className="search-results">
          {!query.trim() ? (
            <div className="search-empty">
              <Search size={24} />
              <p>搜索所有对话</p>
              <span>支持会话标题和当前分支里的消息内容</span>
            </div>
          ) : loading && results.length === 0 ? (
            <div className="search-empty">
              <Loader2 size={22} className="spin" />
              <p>正在搜索…</p>
            </div>
          ) : results.length === 0 ? (
            <div className="search-empty">
              <p>没有找到相关结果</p>
              <span>换个关键词试试</span>
            </div>
          ) : (
            results.map((result, index) => (
              <button
                key={`${result.conversation_id}-${result.message_id ?? 'title'}-${index}`}
                type="button"
                className={`search-result ${index === selectedIndex ? 'active' : ''}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => choose(result)}
              >
                <span className={`search-result-icon ${result.role || 'title'}`}>
                  {result.role === 'user' ? (
                    <User size={15} />
                  ) : result.role === 'assistant' ? (
                    <MessageSquare size={15} />
                  ) : (
                    <Search size={15} />
                  )}
                </span>
                <span className="search-result-body">
                  <span className="search-result-head">
                    <strong>{result.conversation_title}</strong>
                    <small>{formatRelative(result.updated_at)}</small>
                  </span>
                  <span className="search-result-snippet">{result.snippet}</span>
                </span>
                <span className="search-result-role">
                  {result.role === 'user' ? '你' : result.role === 'assistant' ? 'DeepSeek' : '标题'}
                </span>
              </button>
            ))
          )}
        </div>

        <div className="search-foot">
          <span>↑↓ 选择</span>
          <span>Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </div>
    </div>
  );
}
