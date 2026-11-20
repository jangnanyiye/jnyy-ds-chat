import { useEffect, useMemo, useRef, useState } from 'react';
import {
  LogOut,
  MessageSquare,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Sun,
  Trash2,
} from 'lucide-react';
import type { Conversation } from '../types';
import { dayGroup } from '../lib/format';
import { Logo } from './Logo';

export function Sidebar({
  conversations,
  activeId,
  open,
  theme,
  onClose,
  onNew,
  onSearch,
  onSelect,
  onRename,
  onDelete,
  onToggleTheme,
  onLogout,
}: {
  conversations: Conversation[];
  activeId: number | null;
  open: boolean;
  theme: 'light' | 'dark';
  onClose: () => void;
  onNew: () => void;
  onSearch: () => void;
  onSelect: (id: number) => void;
  onRename: (conversation: Conversation) => void;
  onDelete: (conversation: Conversation) => void;
  onToggleTheme: () => void;
  onLogout: () => void;
}) {
  const [menuId, setMenuId] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menuId === null) return;
    const close = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuId(null);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [menuId]);

  const groups = useMemo(() => {
    const order = ['今天', '昨天', '最近 7 天', '更早'];
    const buckets = new Map<string, Conversation[]>();
    for (const conversation of conversations) {
      const key = dayGroup(conversation.updated_at);
      const list = buckets.get(key) || [];
      list.push(conversation);
      buckets.set(key, list);
    }
    return order
      .filter((key) => buckets.has(key))
      .map((key) => ({ label: key, items: buckets.get(key) || [] }));
  }, [conversations]);

  return (
    <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="对话列表">
      <div className="sidebar-head">
        <div className="sidebar-brand">
          <Logo size={30} />
          <span>DeepSeek Chat</span>
        </div>
        <button type="button" className="icon-btn sidebar-close" onClick={onClose} aria-label="收起侧边栏">
          <PanelLeftClose size={19} />
        </button>
      </div>

      <button type="button" className="new-chat" onClick={onNew}>
        <Plus size={18} />
        <span>开启新对话</span>
      </button>

      <button type="button" className="search-entry" onClick={onSearch}>
        <Search size={15} />
        <span>搜索对话</span>
        <kbd>Ctrl K</kbd>
      </button>

      <div className="conversation-scroll">
        {groups.length === 0 ? (
          <div className="sidebar-empty">
            <MessageSquare size={22} />
            <p>还没有对话</p>
            <span>从下面输入框开始</span>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} className="conversation-group">
              <h3>{group.label}</h3>
              {group.items.map((conversation) => (
                <div
                  key={conversation.id}
                  className={`conv-item ${conversation.id === activeId ? 'active' : ''}`}
                  onClick={() => onSelect(conversation.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') onSelect(conversation.id);
                  }}
                >
                  <MessageSquare size={16} className="conv-icon" />
                  <span className="conv-title">{conversation.title}</span>
                  <button
                    type="button"
                    className="conv-more"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMenuId((value) => (value === conversation.id ? null : conversation.id));
                    }}
                    aria-label="对话操作"
                  >
                    <MoreHorizontal size={16} />
                  </button>

                  {menuId === conversation.id && (
                    <div
                      className="conv-menu"
                      ref={menuRef}
                      onClick={(event) => event.stopPropagation()}
                      role="menu"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setMenuId(null);
                          onRename(conversation);
                        }}
                      >
                        <Pencil size={14} />
                        重命名
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setMenuId(null);
                          onDelete(conversation);
                        }}
                      >
                        <Trash2 size={14} />
                        删除
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </section>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <div className="account-row">
          <div className="account-avatar">D</div>
          <div className="account-info">
            <strong>本地用户</strong>
            <span>单用户模式</span>
          </div>
          <button type="button" className="icon-btn" onClick={onLogout} aria-label="退出登录" title="退出登录">
            <LogOut size={17} />
          </button>
        </div>
        <button type="button" className="side-action" onClick={onToggleTheme}>
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          <span>{theme === 'light' ? '深色模式' : '浅色模式'}</span>
        </button>
      </div>
    </aside>
  );
}
