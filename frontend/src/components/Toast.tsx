import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export interface ToastItem {
  id: number;
  type: 'info' | 'success' | 'error';
  message: string;
}

export function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: number) => void;
}) {
  if (!toasts.length) return null;
  return (
    <div className="toast-viewport" role="status" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.type === 'error' ? AlertCircle : toast.type === 'success' ? CheckCircle2 : Info;
        return (
          <div key={toast.id} className={`toast toast-${toast.type}`}>
            <Icon size={16} />
            <span>{toast.message}</span>
            <button type="button" onClick={() => onDismiss(toast.id)} aria-label="关闭提示">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
