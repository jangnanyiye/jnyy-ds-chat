import { useState, type FormEvent } from 'react';
import { Eye, EyeOff, Loader2, LockKeyhole } from 'lucide-react';
import { Logo } from './Logo';
import { ApiError } from '../lib/api';

export function Login({ onLogin }: { onLogin: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password || loading) return;
    setLoading(true);
    setError('');
    try {
      await onLogin(password);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : '登录失败，请稍后重试';
      setError(message);
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-orb login-orb-a" />
      <div className="login-orb login-orb-b" />
      <div className="login-card">
        <div className="login-brand">
          <Logo size={48} />
          <div>
            <h1>DeepSeek Chat</h1>
            <p>私有部署 · 单用户</p>
          </div>
        </div>

        <div className="login-copy">
          <h2>欢迎回来</h2>
          <p>输入访问密码，继续你的对话。</p>
        </div>

        <form onSubmit={submit}>
          <label className="login-label" htmlFor="password">
            访问密码
          </label>
          <div className={`login-input ${error ? 'has-error' : ''}`}>
            <LockKeyhole size={18} />
            <input
              id="password"
              type={show ? 'text' : 'password'}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
                if (error) setError('');
              }}
              placeholder="请输入密码"
              autoComplete="current-password"
              autoFocus
              disabled={loading}
            />
            <button
              type="button"
              className="login-eye"
              onClick={() => setShow((value) => !value)}
              aria-label={show ? '隐藏密码' : '显示密码'}
            >
              {show ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>

          <div className={`login-error ${error ? 'visible' : ''}`} role="alert">
            {error || '\u00a0'}
          </div>

          <button className="login-submit" type="submit" disabled={loading || !password}>
            {loading ? <Loader2 size={18} className="spin" /> : null}
            {loading ? '正在验证…' : '进入聊天'}
          </button>
        </form>

        <p className="login-foot">对话记录只保存在你的服务器上</p>
      </div>
    </div>
  );
}
