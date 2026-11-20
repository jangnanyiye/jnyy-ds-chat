import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react';
import {
  ArrowUp,
  Brain,
  FileText,
  Globe,
  Loader2,
  Paperclip,
  Pencil,
  Square,
  X,
} from 'lucide-react';
import type { Attachment } from '../types';

const ACCEPT =
  '.jpg,.jpeg,.png,.gif,.webp,.pdf,.doc,.docx,.ppt,.pptx,.txt,.md,.markdown,.csv,.json,.xlsx,.xls,.epub,.mobi,image/*';

export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  streaming,
  disabled,
  editing,
  onCancelEdit,
  webSearch,
  onToggleWebSearch,
  deepThinking,
  onToggleDeepThinking,
  attachments,
  uploadingFiles,
  onAddFiles,
  onRemoveAttachment,
  maxAttachments,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  streaming: boolean;
  disabled?: boolean;
  editing?: boolean;
  onCancelEdit?: () => void;
  webSearch: boolean;
  onToggleWebSearch: (enabled: boolean) => void;
  deepThinking: boolean;
  onToggleDeepThinking: (enabled: boolean) => void;
  attachments: Attachment[];
  uploadingFiles: { id: string; name: string }[];
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (attachmentId: string) => void;
  maxAttachments: number;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [value]);

  useEffect(() => {
    if (!streaming && !disabled) textareaRef.current?.focus();
  }, [streaming, disabled, editing]);

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    if (files.length) onAddFiles(files);
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files || []);
    if (files.length) {
      event.preventDefault();
      onAddFiles(files);
    }
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (streaming || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (streaming) return;
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length) onAddFiles(files);
  };

  return (
    <div
      className="composer-wrap"
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setDragging(false);
        }
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept={ACCEPT}
        onChange={handleFileInput}
      />

      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={22} />
          <span>松开以上传文件</span>
        </div>
      )}

      {editing && (
        <div className="edit-banner">
          <Pencil size={14} />
          <span>正在编辑历史消息，发送后将重新生成后续回答</span>
          <button type="button" onClick={onCancelEdit} aria-label="取消编辑">
            <X size={14} />
            取消
          </button>
        </div>
      )}

      {(attachments.length > 0 || uploadingFiles.length > 0) && (
        <div className="attachment-strip">
          {attachments.map((attachment) => (
            <div className={`attachment-chip ${attachment.kind}`} key={attachment.id}>
              {attachment.kind === 'image' ? (
                <img src={attachment.url} alt={attachment.filename} loading="lazy" />
              ) : (
                <span className="attachment-icon">
                  <FileText size={15} />
                </span>
              )}
              <span className="attachment-name" title={attachment.filename}>
                {attachment.filename}
              </span>
              <button
                type="button"
                className="attachment-remove"
                onClick={() => onRemoveAttachment(attachment.id)}
                aria-label={`移除 ${attachment.filename}`}
                disabled={streaming}
              >
                <X size={12} />
              </button>
            </div>
          ))}
          {uploadingFiles.map((file) => (
            <div className="attachment-chip uploading" key={file.id}>
              <span className="attachment-icon">
                <Loader2 size={14} className="spin" />
              </span>
              <span className="attachment-name" title={file.name}>
                {file.name}
              </span>
              <small>解析中</small>
            </div>
          ))}
          <span className="attachment-count">
            {attachments.length + uploadingFiles.length}/{maxAttachments}
          </span>
        </div>
      )}

      <div className={`composer ${streaming ? 'is-streaming' : ''}`}>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          onPaste={handlePaste}
          placeholder={editing ? '编辑消息…' : '给 DeepSeek 发送消息'}
          rows={1}
          maxLength={32000}
          disabled={disabled}
          aria-label="消息输入框"
        />
        <div className="composer-foot">
          <div className="composer-left">
            <button
              type="button"
              className="composer-tool"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming || disabled}
              title="上传文件或图片"
              aria-label="上传文件或图片"
            >
              <Paperclip size={14} />
            </button>
            <button
              type="button"
              className={`web-toggle ${webSearch ? 'active' : ''}`}
              onClick={() => onToggleWebSearch(!webSearch)}
              disabled={streaming}
              aria-pressed={webSearch}
              title={webSearch ? '已开启联网搜索' : '开启联网搜索'}
            >
              <Globe size={14} />
              <span>联网搜索</span>
            </button>
            <button
              type="button"
              className={`web-toggle thinking-toggle ${deepThinking ? 'active' : ''}`}
              onClick={() => onToggleDeepThinking(!deepThinking)}
              disabled={streaming}
              aria-pressed={deepThinking}
              title={deepThinking ? '已开启深度思考' : '开启深度思考'}
            >
              <Brain size={14} />
              <span>深度思考</span>
            </button>
            <span className="composer-hint">Enter 发送 · Shift + Enter 换行</span>
          </div>
          {streaming ? (
            <button type="button" className="send-btn stop" onClick={onStop} aria-label="停止生成">
              <Square size={15} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              onClick={onSend}
              disabled={disabled || !value.trim() || uploadingFiles.length > 0}
              aria-label="发送消息"
            >
              <ArrowUp size={19} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <p className="composer-note">AI 生成内容仅供参考，请自行核实重要信息。</p>
    </div>
  );
}
