import { useEffect, useMemo, useState } from 'react';
import { FilePlus2, Save, Trash2 } from 'lucide-react';
import { ApiError, createPrompt, deletePrompt, updatePrompt } from '../lib/api';
import type { SystemPrompt } from '../types';
import { Modal } from './Modal';

export function PromptLibrary({
  open,
  prompts,
  onClose,
  onPromptsChanged,
  onError,
}: {
  open: boolean;
  prompts: SystemPrompt[];
  onClose: () => void;
  onPromptsChanged: (prompts: SystemPrompt[]) => void;
  onError: (message: string) => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => prompts.find((prompt) => prompt.id === selectedId) || null,
    [prompts, selectedId],
  );

  useEffect(() => {
    if (!open) return;
    if (selectedId === null && prompts.length && !creating) {
      setSelectedId(prompts[0].id);
    }
  }, [open, prompts, selectedId, creating]);

  useEffect(() => {
    if (!selected) {
      if (selectedId !== null && !prompts.some((prompt) => prompt.id === selectedId)) {
        setSelectedId(null);
      }
      return;
    }
    setName(selected.name);
    setContent(selected.content);
  }, [selected, prompts, selectedId]);

  const startNew = () => {
    setCreating(true);
    setSelectedId(null);
    setName('');
    setContent('');
  };

  const selectPrompt = (promptId: number) => {
    setCreating(false);
    setSelectedId(promptId);
  };

  const save = async () => {
    const nextName = name.trim();
    const nextContent = content.trim();
    if (!nextName || !nextContent || saving) return;
    setSaving(true);
    try {
      if (selected) {
        const { prompt } = await updatePrompt(selected.id, {
          name: nextName,
          content: nextContent,
        });
        onPromptsChanged(prompts.map((item) => (item.id === prompt.id ? prompt : item)));
      } else {
        const { prompt } = await createPrompt(nextName, nextContent);
        onPromptsChanged([prompt, ...prompts]);
        setCreating(false);
        setSelectedId(prompt.id);
      }
    } catch (error) {
      onError(error instanceof ApiError ? error.message : '保存提示词失败');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected || saving) return;
    if (
      !window.confirm(
        `删除提示词「${selected.name}」？已经开始的对话会保留当前提示词快照，不受影响。`,
      )
    ) {
      return;
    }
    setSaving(true);
    try {
      await deletePrompt(selected.id);
      const rest = prompts.filter((prompt) => prompt.id !== selected.id);
      onPromptsChanged(rest);
      setCreating(!rest.length);
      setSelectedId(rest[0]?.id ?? null);
      if (!rest.length) {
        setName('');
        setContent('');
      }
    } catch (error) {
      onError(error instanceof ApiError ? error.message : '删除提示词失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title="系统提示词库"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="prompt-library">
        <aside className="prompt-list">
          <button type="button" className="prompt-new" onClick={startNew}>
            <FilePlus2 size={15} />
            新建提示词
          </button>
          {prompts.length === 0 ? (
            <p className="prompt-empty">还没有提示词。给常用角色、写作风格或约束起个名字吧。</p>
          ) : (
            prompts.map((prompt) => (
              <button
                type="button"
                key={prompt.id}
                className={`prompt-item ${prompt.id === selectedId ? 'active' : ''}`}
                onClick={() => selectPrompt(prompt.id)}
              >
                <strong>{prompt.name}</strong>
                <span>{prompt.content.slice(0, 55)}</span>
              </button>
            ))
          )}
        </aside>
        <section className="prompt-editor">
          <label className="prompt-label" htmlFor="prompt-name">
            名称
          </label>
          <input
            id="prompt-name"
            className="text-input"
            value={name}
            maxLength={60}
            placeholder="例如：严谨技术审稿"
            onChange={(event) => setName(event.target.value)}
          />
          <label className="prompt-label" htmlFor="prompt-content">
            提示词内容
          </label>
          <textarea
            id="prompt-content"
            className="prompt-textarea"
            value={content}
            maxLength={12000}
            placeholder="你是一个……请始终……"
            onChange={(event) => setContent(event.target.value)}
          />
          <div className="prompt-actions">
            <button
              type="button"
              className="btn primary"
              onClick={() => void save()}
              disabled={!name.trim() || !content.trim() || saving}
            >
              <Save size={14} />
              {selected ? '保存修改' : '创建提示词'}
            </button>
            {selected && (
              <button
                type="button"
                className="btn danger"
                onClick={() => void remove()}
                disabled={saving}
              >
                <Trash2 size={14} />
                删除
              </button>
            )}
          </div>
        </section>
      </div>
    </Modal>
  );
}
