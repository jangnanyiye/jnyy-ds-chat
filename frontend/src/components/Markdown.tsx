import { useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import hljs from 'highlight.js/lib/common';
import 'highlight.js/styles/atom-one-dark.css';
import 'katex/dist/katex.min.css';
import { Check, Copy } from 'lucide-react';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);

  const highlighted = useMemo(() => {
    try {
      if (language && hljs.getLanguage(language)) {
        return hljs.highlight(code, { language }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, language]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // 忽略剪贴板权限问题
    }
  };

  return (
    <div className="code-block">
      <div className="code-head">
        <span>{language || 'text'}</span>
        <button type="button" onClick={copy} aria-label="复制代码">
          {copied ? <Check size={14} /> : <Copy size={14} />}
          <span>{copied ? '已复制' : '复制'}</span>
        </button>
      </div>
      <pre>
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

const components: Components = {
  pre({ children }) {
    const first = Array.isArray(children) ? children[0] : children;
    const props =
      first && typeof first === 'object' && 'props' in first
        ? (first as { props: { className?: string; children?: ReactNode } }).props
        : undefined;
    const className = props?.className || '';
    const language = /language-([\w+-]+)/.exec(className)?.[1] || '';
    const code = String(props?.children ?? '').replace(/\n$/, '');
    return <CodeBlock code={code} language={language} />;
  },
  code({ className, children }) {
    return <code className={className}>{children}</code>;
  },
  a({ href, children }) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  img({ src, alt }) {
    return <img src={src} alt={alt || ''} loading="lazy" referrerPolicy="no-referrer" />;
  },
};

export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: false }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
