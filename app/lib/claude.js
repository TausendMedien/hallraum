import Anthropic from '@anthropic-ai/sdk';
import { transcriptForPrompt } from './transcript.js';
import { languageData } from './languages.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

export const claudeAvailable = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chapters', 'sections'],
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['start', 'title', 'summary'],
        properties: {
          start: { type: 'number', description: 'Start time in seconds, taken from the time marks in the transcript' },
          title: { type: 'string' },
          summary: { type: 'string' },
        },
      },
    },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['start', 'end', 'title', 'tags'],
        properties: {
          start: { type: 'number' },
          end: { type: 'number' },
          title: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

function buildPrompt({ podcast, episode, words, speakerNames, existingTags }) {
  const lang = languageData(podcast.language).name;
  return `You are helping the editorial team of the podcast "${podcast.name}"${podcast.subtitle ? ` (${podcast.subtitle})` : ''} prepare an episode.
${podcast.description ? `About the podcast: ${podcast.description}\n` : ''}
Episode: "${episode.title}"${episode.guest ? `, guest: ${episode.guest}` : ''}.

Below is the transcript. Each paragraph starts with its start time in seconds in square brackets.

Tasks:
1. Chapters: split the episode into 4–12 chapters. The first chapter starts at 0. Titles short and concrete (max. 6 words), summary 1–2 sentences. Start times must be time marks from the transcript.
2. Sections with tags: mark the most substantial passages (typically 5–15 per hour), each 30 seconds to 8 minutes long, with a short title and 1–3 topic tags. The tags let listeners hear passages on the same topic across many episodes as a playlist. Prefer these existing tags when they fit: ${existingTags.length ? existingTags.join(', ') : '(none yet)'}. Only create new tags when no existing one fits; short, general, one or two words, no duplicates in different spellings.

Write all titles, summaries and tags in ${lang}.

<transcript>
${transcriptForPrompt(words, speakerNames)}
</transcript>`;
}

export async function suggestChaptersAndTags(ctx) {
  if (!claudeAvailable()) throw new Error('no Claude API key configured (ANTHROPIC_API_KEY)');
  const client = new Anthropic();
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: buildPrompt(ctx) }],
  });
  const msg = await stream.finalMessage();
  if (msg.stop_reason === 'refusal') throw new Error('Claude declined the request');
  if (msg.stop_reason === 'max_tokens') throw new Error('Claude\'s answer was too long and got cut off');
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const data = JSON.parse(text);
  return normalize(data, ctx.words);
}

// Clamp times to valid ranges
export function normalize(data, words) {
  const dur = words.at(-1)?.e || 0;
  const clamp = (t) => Math.max(0, Math.min(dur, Number(t) || 0));
  const chapters = (data.chapters || []).map((c) => ({ start: clamp(c.start), title: String(c.title).trim(), summary: String(c.summary || '').trim() }))
    .filter((c) => c.title).sort((a, b) => a.start - b.start);
  if (chapters.length) chapters[0].start = 0;
  const sections = (data.sections || []).map((s) => ({
    start: clamp(s.start), end: clamp(s.end), title: String(s.title || '').trim(),
    tags: [...new Set((s.tags || []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 5),
  })).filter((s) => s.end > s.start);
  return { chapters, sections };
}
