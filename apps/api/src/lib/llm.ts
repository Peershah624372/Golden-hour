/**
 * Minimal client for any OpenAI-compatible chat-completions API (Gemini, Groq, OpenAI...).
 *   Gemini: LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
 *   Groq:   LLM_BASE_URL=https://api.groq.com/openai/v1
 * With no LLM_API_KEY the system runs on rules only; AI is never a single point of failure.
 */
const BASE = (process.env.LLM_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const KEY = process.env.LLM_API_KEY ?? '';
export const LLM_MODEL = process.env.LLM_MODEL ?? 'gemini-2.5-flash';

export const llmEnabled = () => KEY.length > 0;

export async function llmJson<T>(system: string, user: string, timeoutMs = 12000): Promise<T | null> {
  if (!llmEnabled()) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model: LLM_MODEL,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
    if (!res.ok) {
      console.warn('[llm] HTTP %d: %s', res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = data.choices?.[0]?.message?.content ?? '';
    return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as T;
  } catch (err) {
    console.warn('[llm] failed:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
