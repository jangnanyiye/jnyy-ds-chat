import type { ReactNode } from 'react';
import { BookOpen, LogOut, Settings2 } from 'lucide-react';
import type { Preferences } from '../lib/prefs';
import type { SystemPrompt } from '../types';
import { Modal } from './Modal';

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      className={`switch ${checked ? 'on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div className="setting-copy">
        <strong>{title}</strong>
        {description && <p>{description}</p>}
      </div>
      <div className="setting-control">{children}</div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onClose,
  theme,
  onThemeChange,
  darkLock,
  onDarkLockChange,
  preferences,
  onPreferencesChange,
  prompts,
  onManagePrompts,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  theme: 'light' | 'dark';
  onThemeChange: (dark: boolean) => void;
  darkLock: boolean;
  onDarkLockChange: (locked: boolean) => void;
  preferences: Preferences;
  onPreferencesChange: (patch: Partial<Preferences>) => void;
  prompts: SystemPrompt[];
  onManagePrompts: () => void;
  onLogout: () => void;
}) {
  return (
    <Modal
      open={open}
      title="设置"
      wide
      onClose={onClose}
      footer={
        <button type="button" className="btn ghost" onClick={onClose}>
          关闭
        </button>
      }
    >
      <div className="settings-page">
        <section className="settings-section">
          <h3>
            <Settings2 size={15} />
            主题
          </h3>
          <SettingRow
            title="深色模式"
            description={darkLock ? '已锁定深色模式' : '未锁定，加载时跟随系统'}
          >
            <Toggle
              checked={theme === 'dark'}
              disabled={darkLock}
              onChange={onThemeChange}
              label="深色模式"
            />
          </SettingRow>
          <SettingRow
            title="锁定深色模式"
            description="开启后每次加载都强制深色；关闭后优先读取系统设置"
          >
            <Toggle
              checked={darkLock}
              onChange={onDarkLockChange}
              label="锁定深色模式"
            />
          </SettingRow>
        </section>

        <section className="settings-section">
          <h3>对话</h3>
          <SettingRow title="回复显示 token 使用">
            <Toggle
              checked={preferences.showTokenUsage}
              onChange={(value) => onPreferencesChange({ showTokenUsage: value })}
              label="回复显示 token 使用"
            />
          </SettingRow>
          <SettingRow title="回复显示助手头像和名称">
            <Toggle
              checked={preferences.showAssistantIdentity}
              onChange={(value) =>
                onPreferencesChange({ showAssistantIdentity: value })
              }
              label="回复显示助手头像和名称"
            />
          </SettingRow>
          <SettingRow title="顶部标题栏显示对话名称">
            <Toggle
              checked={preferences.showChatTitle}
              onChange={(value) => onPreferencesChange({ showChatTitle: value })}
              label="顶部标题栏显示对话名称"
            />
          </SettingRow>
          <SettingRow
            title="开始对话时显式发送系统提示词"
            description="在首条用户消息前展示（实际作为系统消息发送）"
          >
            <Toggle
              checked={preferences.showSystemPromptMessage}
              onChange={(value) =>
                onPreferencesChange({ showSystemPromptMessage: value })
              }
              label="开始对话时显式发送系统提示词"
            />
          </SettingRow>
          <SettingRow title="新对话默认设置">
            <div className="settings-defaults">
              <select
                className="settings-select"
                value={preferences.defaultPromptId ?? ''}
                onChange={(event) =>
                  onPreferencesChange({
                    defaultPromptId: event.target.value
                      ? Number(event.target.value)
                      : null,
                  })
                }
                aria-label="新对话默认提示词"
              >
                <option value="">不使用提示词</option>
                {prompts.map((prompt) => (
                  <option key={prompt.id} value={prompt.id}>
                    {prompt.name}
                  </option>
                ))}
              </select>
              <label className="settings-inline-toggle">
                <span>默认单轮</span>
                <Toggle
                  checked={preferences.defaultSingleTurn}
                  onChange={(value) =>
                    onPreferencesChange({ defaultSingleTurn: value })
                  }
                  label="新对话默认单轮"
                />
              </label>
            </div>
          </SettingRow>
          <SettingRow title="提示词库">
            <button type="button" className="btn ghost" onClick={onManagePrompts}>
              管理提示词库
            </button>
          </SettingRow>
        </section>

        <section className="settings-section">
          <h3>系统</h3>
          <SettingRow
            title="搜索步进"
            description="每次加载对话和搜索结果的数量"
          >
            <select
              className="settings-select settings-step"
              value={preferences.searchStep}
              onChange={(event) =>
                onPreferencesChange({ searchStep: Number(event.target.value) })
              }
              aria-label="搜索步进"
            >
              {[10, 20, 30, 50].map((step) => (
                <option key={step} value={step}>
                  {step} 条
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title="退出登录">
            <button type="button" className="btn ghost" onClick={onLogout}>
              <LogOut size={14} />
              退出登录
            </button>
          </SettingRow>
        </section>

        <section className="settings-section">
          <h3>
            <BookOpen size={15} />
            关于
          </h3>
          <details className="settings-manual">
            <summary>手册 · 模型、单轮、引用与搜索</summary>
            <div className="manual-content">
              <h4>模型</h4>
              <p>
                V4-Pro 适合通用问答和深度思考；V4.1 Flash 响应更快，联网搜索和文件/图片必须使用它。
                深度思考可以在输入框旁开启，联网搜索与附件会自动切换 Flash。
              </p>
              <h4>单轮对话</h4>
              <p>
                单轮模式只在对话开始前设置。开启后每轮只发送当前问题、系统提示词和手动引用，
                不携带历史消息，适合同类独立问题，能减少 token 和注意力干扰。消息仍会保存在对话中。
              </p>
              <h4>系统提示词</h4>
              <p>
                提示词库可保存常用角色和约束。对话开始时选择后会随对话保存一份快照，
                之后修改或删除提示词库中的条目不会影响已经开始的对话。
              </p>
              <h4>引用</h4>
              <p>
                点击消息下方的「引用」可以把历史问答带入本轮，最多 8 条。引用不能单独发送，
                需要同时输入问题或添加附件；在单轮对话中可以用它追问。
              </p>
              <h4>搜索与分页</h4>
              <p>
                对话列表和搜索结果按最近更新时间从近到远加载。设置里的「搜索步进」控制每次加载数量，
                点击「加载更多」继续读取。
              </p>
              <h4>PWA</h4>
              <p>
                Android Chrome / Edge 可安装到主屏幕。再次启动会优先复用已打开窗口，
                并适配状态栏、刘海和底部手势条。
              </p>
            </div>
          </details>
        </section>
      </div>
    </Modal>
  );
}
