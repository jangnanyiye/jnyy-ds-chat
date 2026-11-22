import { useEffect, useRef, useState } from 'react';
import { Brain, Check, ChevronDown, Zap } from 'lucide-react';
import { MODELS, type Model } from '../types';

export function ModelPicker({
  model,
  disabled,
  onChange,
}: {
  model: Model;
  disabled?: boolean;
  onChange: (model: Model) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = MODELS.find((item) => item.id === model) || MODELS[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={`model-trigger ${open ? 'open' : ''}`}
        onClick={() => !disabled && setOpen((value) => !value)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {model === 'deepseek-flash' ? <Zap size={15} /> : <Brain size={15} />}
        <span>{selected.short}</span>
        <ChevronDown size={14} className={open ? 'rotated' : ''} />
      </button>

      {open && (
        <div className="model-menu" role="listbox">
          {MODELS.map((item) => {
            const Icon = item.id === 'deepseek-flash' ? Zap : Brain;
            return (
              <button
                key={item.id}
                type="button"
                className={`model-option ${item.id === model ? 'active' : ''}`}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
                role="option"
                aria-selected={item.id === model}
              >
                <span className="model-option-icon">
                  <Icon size={17} />
                </span>
                <span className="model-option-copy">
                  <strong>{item.name}</strong>
                </span>
                {item.id === model && <Check size={16} />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
