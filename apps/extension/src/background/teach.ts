// ─────────────────────────────────────────────
// /teach — a workspace becomes a course
// ─────────────────────────────────────────────
// Ported from the filesystem `teach` skill, which kept its state in a directory
// (MISSION.md, lessons/*.html, learning-records/). There is no filesystem here,
// so the state maps onto workspace primitives instead:
//
//   MISSION.md        → project.rules   (persistent, injected into every prompt)
//   lessons/*.html    → saved documents (browsable, Drive-synced, revisitable)
//   learning records  → lesson frontmatter (`covers:`), read back to place the
//                       next lesson in the zone of proximal development
//
// Lessons must OUTLIVE the chat. A lesson that only exists as a chat message is
// gone the moment the transcript scrolls, which defeats the point — the learner
// returns to these to review.

import { getProject, updateProjectRules, listDocuments, linkDocumentToProject, saveDocument } from '../lib/db';
import { buildFrontmatter } from '../lib/frontmatter';
import { chatWithCustom } from './llm-client';

/** Delimited so a mission can be rewritten without clobbering the user's own
 *  workspace rules, which live in the same field and are theirs, not ours. */
export const MISSION_OPEN = '<!-- magpie:mission -->';
export const MISSION_CLOSE = '<!-- /magpie:mission -->';

export interface PriorLesson { number: number; title: string; covers: string }

export interface TeachResult {
  lessonNumber: number;
  title: string;
  docId: string;
  mission: string;
  missionCreated: boolean;
  body: string;
  covers: string;
}

/** Pull the mission out of a workspace's rules, if a course was started here. */
export function parseMissionBlock(rules: string | undefined): string | null {
  if (!rules) return null;
  const start = rules.indexOf(MISSION_OPEN);
  const end = rules.indexOf(MISSION_CLOSE);
  if (start === -1 || end === -1 || end < start) return null;
  const body = rules.slice(start + MISSION_OPEN.length, end).trim();
  return body || null;
}

/**
 * Write the mission into the rules, replacing any previous one. Anything the
 * user wrote themselves is preserved verbatim — their rules are not ours to
 * rewrite, and silently dropping them would be a nasty surprise.
 */
export function upsertMissionBlock(rules: string | undefined, mission: string): string {
  const block = `${MISSION_OPEN}\n${mission.trim()}\n${MISSION_CLOSE}`;
  const existing = rules || '';
  const start = existing.indexOf(MISSION_OPEN);
  const end = existing.indexOf(MISSION_CLOSE);
  if (start !== -1 && end !== -1 && end > start) {
    return (existing.slice(0, start) + block + existing.slice(end + MISSION_CLOSE.length)).trim();
  }
  return existing.trim() ? `${existing.trim()}\n\n${block}` : block;
}

/** Read a single frontmatter field. Tolerates quoted and bare values. */
function frontmatterField(content: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(content.slice(0, 1200));
  if (!m) return '';
  return m[1].trim().replace(/^["']|["']$/g, '');
}

/**
 * Lessons already taught in this workspace, oldest first. Drives both the
 * numbering and the zone of proximal development — you cannot pitch the next
 * lesson correctly without knowing what the learner already has.
 */
export function priorLessons(docs: Array<{ title: string; content: string }>): PriorLesson[] {
  return docs
    .filter(d => frontmatterField(d.content, 'type') === 'lesson')
    .map(d => ({
      number: parseInt(frontmatterField(d.content, 'lesson') || '0', 10) || 0,
      title: d.title.replace(/^Lesson\s+\d+:\s*/i, '').trim() || d.title,
      covers: frontmatterField(d.content, 'covers'),
    }))
    .sort((a, b) => a.number - b.number);
}

export function nextLessonNumber(prior: PriorLesson[]): number {
  return prior.reduce((max, l) => Math.max(max, l.number), 0) + 1;
}

/** Split the model's reply into its title, what it covers, and the lesson body. */
export function parseLessonResponse(raw: string): { title: string; covers: string; body: string } | null {
  const titleMatch = /^TITLE:\s*(.+)$/m.exec(raw);
  const coversMatch = /^COVERS:\s*(.+)$/m.exec(raw);
  const bodyMatch = /^LESSON:\s*$/m.exec(raw);
  if (!titleMatch || !bodyMatch) return null;
  const body = raw.slice(bodyMatch.index + bodyMatch[0].length).trim();
  if (body.length < 120) return null;   // a lesson this short taught nothing
  return {
    title: titleMatch[1].trim().slice(0, 120),
    covers: (coversMatch?.[1] || '').trim().slice(0, 200),
    body,
  };
}

const PEDAGOGY = `
Teaching principles — these are what separate a lesson from a lecture:

- Aim at STORAGE strength, not fluency. Re-reading feels like learning and isn't; the
  learner walks away confident and empty-handed. Build retention through desirable
  difficulty: make them retrieve from memory rather than recognize.
- ONE tangible win per lesson. Working memory is small, and a lesson that teaches three
  things usually teaches none. Short and finishable beats comprehensive.
- Ground every lesson in the mission. Untethered from why they care, lessons drift
  abstract and the learner cannot tell what to do next.
- Teach only the knowledge the skill requires, then make them practise it. For
  acquisition difficulty is the enemy — it eats the working memory needed to understand.
  For practice difficulty is the tool — effortful retrieval is what makes it stick.
- Cite sources for factual claims, and recommend ONE high-quality primary source to read
  or watch. Do not rely on your own recall for facts a learner will build on.
- If you write quiz options, make them the same length. Unequal lengths let the learner
  pattern-match the answer instead of knowing it, which tests nothing.
- Never put answers where the learner can see them while reading the question. An answer
  in view turns retrieval back into recognition and the practice stops working. Put them
  at the very end under a "## Answers" heading, after the source recommendation.
- Stay inside the one win. Material that belongs to the NEXT lesson should be left for it —
  a lesson that previews the sequel spoils it and leaves the sequel with nothing to teach.
  Name the boundary instead ("we'll cover the write cost next time") when it helps.
- Write plain markdown. LaTeX renders as raw source here, so write "O(log n)", not "$O(\\log n)$".
  Use \`##\` for section headings consistently.
`.trim();

/**
 * Draft a mission from the learner's opening request. The original skill blocks
 * on an interview here; that is right for a coding agent and wrong for a chat
 * box, where a wall of questions before any teaching reads as friction. Instead
 * we commit to an explicit, stated mission and invite correction — the learner
 * sees exactly what was assumed and can redirect in one message.
 */
async function draftMission(topic: string, workspaceTitle: string, pageContext?: { title: string; url: string; markdown: string }): Promise<string> {
  const sys =
    'You infer a learner\'s real goal from how they describe what they want to learn.\n\n' +
    'Write 2-4 sentences covering: what they want to be able to DO (concrete capability, not ' +
    '"understand X"), the context it will be used in, and the level they are starting from. ' +
    'Where they have not said, make the most probable assumption and state it plainly as an ' +
    'assumption — a stated wrong guess gets corrected, a vague one silently misdirects every ' +
    'later lesson.\n\nReturn ONLY the mission text, no preamble or heading.';
  let user = `Workspace: ${workspaceTitle}\nThey want to learn: ${topic}`;
  if (pageContext) {
    user += `\n\nCURRENT PAGE CONTEXT (the learner asked about this page):\nTitle: ${pageContext.title}\nURL: ${pageContext.url}\nContent:\n${pageContext.markdown.slice(0, 4000)}`;
  }
  const out = await chatWithCustom(sys, [], user);
  return out.trim().slice(0, 1200);
}

async function writeLesson(
  mission: string, topic: string, lessonNumber: number, prior: PriorLesson[], pageContext?: { title: string; url: string; markdown: string }
): Promise<{ title: string; covers: string; body: string }> {
  const history = prior.length
    ? prior.map(l => `- Lesson ${l.number}: ${l.title}${l.covers ? ` — covers ${l.covers}` : ''}`).join('\n')
    : '(none yet — this is the first lesson)';

  const sys =
    `You are a teacher writing lesson ${lessonNumber} of an ongoing course. The learner returns to ` +
    `these lessons to review, so write something worth keeping.\n\n${PEDAGOGY}\n\n` +
    `Pitch this lesson at the edge of what they can already do — building on the lessons below without ` +
    `repeating them, and without skipping the rungs in between. If the learner named something specific ` +
    `they want next, teach that.\n\n` +
    `Reply in EXACTLY this format:\n` +
    `TITLE: <short lesson title, no "Lesson N:" prefix>\n` +
    `COVERS: <comma-separated list of everything this lesson actually explains, including points made ` +
    `in passing. Later lessons see only this line, so anything you omit here is liable to be taught ` +
    `again from scratch.>\n` +
    `LESSON:\n` +
    `<the lesson in markdown: open with the one thing they'll be able to do by the end, then the ` +
    `minimum knowledge needed, then a practice section that makes them retrieve rather than re-read, ` +
    `then "## Read next" with one primary source, then one sentence inviting them to ask you follow-ups ` +
    `right here in chat, and finally "## Answers" if the practice had answerable questions. ` +
    `Around 400-700 words — finishable in one sitting.>`;

  const user =
    `MISSION (why they are learning this):\n${mission}\n\n` +
    `LESSONS SO FAR:\n${history}\n\n` +
    `THIS REQUEST: ${topic || '(no specific request — choose the best next lesson)'}` +
    (pageContext ? `\n\nCURRENT PAGE CONTEXT (the learner asked about this page — write the lesson around it):\nTitle: ${pageContext.title}\nURL: ${pageContext.url}\nContent:\n${pageContext.markdown.slice(0, 4000)}` : '');

  const raw = await chatWithCustom(sys, [], user);
  const parsed = parseLessonResponse(raw);
  if (!parsed) throw new Error('Lesson generation failed — the model did not return a usable lesson');
  return parsed;
}

/**
 * `/teach <topic>` — establish the mission on first use, then write and SAVE the
 * next lesson into this workspace.
 */
export async function handleTeach(request: Record<string, unknown>, pageContext?: { title: string; url: string; markdown: string } | null): Promise<Record<string, unknown>> {
  const projectId = String(request.projectId || '');
  const topic = String(request.topic || '').trim();
  if (!projectId) throw new Error('No workspace selected');

  const project = await getProject(projectId);
  if (!project) throw new Error('Workspace not found');

  let mission = parseMissionBlock(project.rules);
  let missionCreated = false;
  if (!mission) {
    if (!topic) {
      throw new Error('Tell me what you want to learn — e.g. `/teach spaced repetition for language learning`');
    }
    mission = await draftMission(topic, project.title || 'this workspace', pageContext || undefined);
    await updateProjectRules(projectId, upsertMissionBlock(project.rules, mission));
    missionCreated = true;
  }

  const docs = await listDocuments(projectId);
  const prior = priorLessons(docs);
  const lessonNumber = nextLessonNumber(prior);

  const { title, covers, body } = await writeLesson(mission, topic, lessonNumber, prior, pageContext || undefined);

  const docTitle = `Lesson ${lessonNumber}: ${title}`;
  const wordCount = body.split(/\s+/).filter(Boolean).length;
  const content = buildFrontmatter({
    title: docTitle,
    type: 'lesson',
    wordCount,
    extra: { lesson: lessonNumber, covers },
  }) + body;

  const { id: docId } = await saveDocument({
    title: docTitle,
    url: '',
    content,
    capturedAt: new Date().toISOString(),
    favicon: '',
    wordCount,
    syncedToDrive: false,
  }, []);
  await linkDocumentToProject(projectId, docId);

  return { lessonNumber, title, docId, mission, missionCreated, body, covers } satisfies TeachResult as unknown as Record<string, unknown>;
}
