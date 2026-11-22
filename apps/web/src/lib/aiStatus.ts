import { useEffect, useState } from 'react';
import { api } from './api';

export interface AiStatus {
  enabled: boolean;
  model: string | null;
}

let cached: Promise<AiStatus> | null = null;

/** Is the AI layer on? (Off = the red-flag rules and the dispatcher run everything; nothing breaks.) */
export function useAiStatus(): AiStatus | null {
  const [s, setS] = useState<AiStatus | null>(null);
  useEffect(() => {
    cached ??= api<{ ai: string }>('/health')
      .then((h) => ({ enabled: h.ai !== 'rules-only', model: h.ai !== 'rules-only' ? h.ai : null }))
      .catch(() => {
        cached = null;
        return { enabled: false, model: null };
      });
    void cached.then(setS);
  }, []);
  return s;
}
