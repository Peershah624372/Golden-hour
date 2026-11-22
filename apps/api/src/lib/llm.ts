/**
 * Minimal client for any OpenAI-compatible chat-completions API (Gemini, Groq, OpenAI...).
 *   Gemini: LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
 *   Groq:   LLM_BASE_URL=https://api.groq.com/openai/v1
 * With no LLM_API_KEY the system runs on rules only; AI is never a single point of failure.
 */
// Read on use (not at load), so configuration set by the host or a test harness always applies.
const base = () => (process.env.LLM_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, '');
const key = () => process.env.LLM_API_KEY ?? '';
export const llmModel = () => process.env.LLM_MODEL || 'gemini-2.5-flash';
export const llmEnabled = () => key().length > 0;
const defaultTimeoutMs = () => Number(process.env.LLM_TIMEOUT_MS || 12000);

/**
 * Data minimisation: the AI needs the emergency, not the people. Phone numbers, CNIC
 * (national ID) numbers and e-mail addresses are removed before any text leaves the server.
 */
export function redactPII(text: string): string {
  return text
    .replace(/\b\d{5}-\d{7}-\d\b/g, '[id-number]') // CNIC 12345-1234567-1
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/(?:\+|\b)\d[\d\s-]{7,}\d\b/g, '[phone]');
}

export async function llmJson<T>(system: string, user: string, timeoutMs = defaultTimeoutMs()): Promise<T | null> {
  if (!llmEnabled()) return null;
  user = redactPII(user);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base()}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}` },
      body: JSON.stringify({
        model: llmModel(),
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
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) as unknown;
    // Only a JSON object is a usable answer; anything else is treated as "no AI".
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as T;
  } catch (err) {
    console.warn('[llm] failed:', (err as Error).message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
