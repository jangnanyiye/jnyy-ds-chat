export interface Preferences {
  showTokenUsage: boolean;
  showAssistantIdentity: boolean;
  showChatTitle: boolean;
  showSystemPromptMessage: boolean;
  defaultPromptId: number | null;
  defaultSingleTurn: boolean;
  searchStep: number;
}

export const PREFS_KEY = 'dschat.preferences';
export const DARK_LOCK_KEY = 'dschat.dark-lock';
export const DEFAULT_SEARCH_STEP = 20;

const DEFAULTS: Preferences = {
  showTokenUsage: true,
  showAssistantIdentity: true,
  showChatTitle: true,
  showSystemPromptMessage: false,
  defaultPromptId: null,
  defaultSingleTurn: false,
  searchStep: DEFAULT_SEARCH_STEP,
};

function validStep(value: unknown): number {
  const step = Number(value);
  return Number.isFinite(step) && step >= 5 && step <= 100
    ? Math.round(step)
    : DEFAULT_SEARCH_STEP;
}

export function loadPreferences(): Preferences {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULTS };
    const stored = JSON.parse(raw) as Partial<Preferences>;
    return {
      showTokenUsage: stored.showTokenUsage !== false,
      showAssistantIdentity: stored.showAssistantIdentity !== false,
      showChatTitle: stored.showChatTitle !== false,
      showSystemPromptMessage: stored.showSystemPromptMessage === true,
      defaultPromptId:
        typeof stored.defaultPromptId === 'number' ? stored.defaultPromptId : null,
      defaultSingleTurn: stored.defaultSingleTurn === true,
      searchStep: validStep(stored.searchStep),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePreferences(preferences: Preferences): void {
  localStorage.setItem(PREFS_KEY, JSON.stringify(preferences));
}

export function isDarkLocked(): boolean {
  return localStorage.getItem(DARK_LOCK_KEY) === '1';
}

export function setDarkLocked(locked: boolean): void {
  if (locked) localStorage.setItem(DARK_LOCK_KEY, '1');
  else localStorage.removeItem(DARK_LOCK_KEY);
}

export function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function initialTheme(): 'light' | 'dark' {
  return isDarkLocked() || systemPrefersDark() ? 'dark' : 'light';
}
