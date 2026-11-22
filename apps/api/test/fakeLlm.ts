// A stand-in for any OpenAI-compatible AI (Gemini, Groq...). Imported BEFORE the app so the
// app's AI client points here. Each test decides what the "AI" answers, how slowly, or how badly.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Reply = { json?: unknown; raw?: string; status?: number; delayMs?: number };
export interface Seen {
  system: string;
  user: string;
}

let next: (req: Seen) => Reply = () => ({ status: 503 });
export const seen: Seen[] = [];
export function aiAnswers(fn: (req: Seen) => Reply) {
  next = fn;
}

const read = (req: IncomingMessage) =>
  new Promise<string>((res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => res(b));
  });

const server = createServer(async (req, res) => {
  const body = JSON.parse(await read(req)) as { messages: { role: string; content: string }[] };
  const s: Seen = { system: body.messages.find((m) => m.role === 'system')?.content ?? '', user: body.messages.find((m) => m.role === 'user')?.content ?? '' };
  seen.push(s);
  const r = next(s);
  if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
  if (res.destroyed) return;
  res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
  const content = r.raw ?? JSON.stringify(r.json ?? {});
  res.end(JSON.stringify({ choices: [{ message: { content } }] }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

process.env.GH_TEST_FAKE_LLM = '1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_MODEL = 'fake-model';
process.env.LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.env.LLM_TIMEOUT_MS = '800';

export const closeFakeLlm = () => new Promise<void>((r) => server.close(() => r()));
