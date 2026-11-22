import { useEffect, useRef, useState } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import type { SystemPrompt } from '../types';

export function ConversationSettings({
  systemPromptId,
  systemPromptName,
  singleTurn,
  prompts,
  disabled,
  locked,
  onSelectPrompt,
  onToggleSingleTurn,
  onManagePrompts,
}: {
  systemPromptId: number | null;
  systemPromptName: string;
  singleTurn: boolean;
  prompts: SystemPrompt[];
  disabled: boolean;
  locked: boolean;
  onSelectPrompt: (promptId: number | null) => void;
  onToggleSingleTurn: (enabled: boolean) => void;
  onManagePrompts: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const active = systemPromptId !== null || singleTurn;

  return (
    <div className="conversation-settings" ref={rootRef}>
      <button
        type="button"
        className={`icon-btn settings-trigger ${active ? 'active' : ''}`}
        onClick={() => setOpen((value) => !value)}
        disabled={disabled}
        aria-label="对话设置"
        title="对话设置"
        aria-expanded={open}
      >
        <SlidersHorizontal size={17} />
        {active && <span className="settings-dot" />}
      </button>
      {open && (
        <div className="settings-menu">
          <div className="settings-head">
            <strong>对话设置</strong>
            <span>本对话生效</span>
          </div>

          <label className="settings-label" htmlFor="conversation-prompt">
            系统提示词
          </label>
          {locked ? (
            <div className="settings-readonly">
              {systemPromptName || '不使用'}
            </div>
          ) : (
            <select
              id="conversation-prompt"
              className="settings-select"
              value={systemPromptId ?? ''}
              disabled={disabled}
              onChange={(event) =>
                onSelectPrompt(event.target.value ? Number(event.target.value) : null)
              }
            >
              <option value="">不使用</option>
              {prompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {prompt.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="settings-link"
            onClick={() => {
              setOpen(false);
              onManagePrompts();
            }}
          >
            管理提示词库
          </button>

          <div className="settings-divider" />

          <div className="settings-switch-row">
            <div>
              <strong>单轮对话</strong>
            </div>
            <button
              type="button"
              className={`switch ${singleTurn ? 'on' : ''}`}
              onClick={() => onToggleSingleTurn(!singleTurn)}
              disabled={disabled || locked}
              role="switch"
              aria-checked={singleTurn}
              aria-label="单轮对话"
            >
              <span />
            </button>
          </div>
          {locked && (
            <p className="settings-locked-note">
              对话开始后，系统提示词和单轮模式不可修改。新建对话时设置会更稳定。
            </p>
          )}
        </div>
      )}
    </div>
  );
}
