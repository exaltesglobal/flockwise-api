// Claude for the engine's AI features, through the official Anthropic SDK.
import Anthropic from '@anthropic-ai/sdk';

import { config } from './config.js';
import type { AiBlock, AiRequest, AiResponse } from './core/index.js';

let client: Anthropic | null = null;

export const aiConfigured = () => !!config.anthropic.apiKey;

export async function claude(req: AiRequest): Promise<AiResponse> {
  client ??= new Anthropic({ apiKey: config.anthropic.apiKey, maxRetries: 2, timeout: 120_000 });
  try {
    const res = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: req.maxTokens ?? 4000,
      system: req.system,
      messages: req.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : m.content.map((b) => (b.type === 'opaque' ? b.value : b.type === 'image' ? { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } } : b)) })) as Anthropic.MessageParam[],
      ...(req.tools?.length ? { tools: req.tools.map((t) => ({ ...t, input_schema: { type: 'object' as const, ...t.input_schema } })) } : {}),
      output_config: { effort: req.effort ?? 'medium', ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}) },
    });
    // Text and tool calls are read by the engine; everything else (thinking) rides along as an
    // opaque block, because the next turn of a tool loop must send it back unchanged.
    const content = res.content.map((b): AiBlock =>
      b.type === 'text' ? { type: 'text', text: b.text } : b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input as Record<string, unknown> } : { type: 'opaque', value: b },
    );
    return { content, stopReason: res.stop_reason ?? 'end_turn' };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) throw new Error('The AI service is busy. Try again in a minute.');
    if (e instanceof Anthropic.AuthenticationError) throw new Error('The AI key on the server is not valid. Ask the Flockwise team.');
    if (e instanceof Anthropic.APIError) throw new Error(`The AI service returned an error (${e.status ?? 'network'}).`);
    throw e;
  }
}
