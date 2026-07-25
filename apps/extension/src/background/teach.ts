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

import { getProject, updateProjectRules, listDocuments, linkDocumentToProject, saveDocument, getChatHistory } from '../lib/db';
import { buildFrontmatter, splitFrontmatter } from '../lib/frontmatter';
import { chatWithCustom } from './llm-client';

/** Delimited so a mission can be rewritten without clobbering the user's own
 *  workspace rules, which live in the same field and are theirs, not ours. */
export const MISSION_OPEN = '<!-- magpie:mission -->';
export const MISSION_CLOSE = '<!-- /magpie:mission -->';

export interface PriorLesson { number: number; title: string; covers: string }

/** One step of a course syllabus built from the workspace's research. */
export interface SyllabusStep { n: number; title: string; covers: string; goal: string }

/** One interactive quiz question. `mcq` is checked locally; `open` is LLM-graded. */
export interface QuizQuestion {
  type: 'mcq' | 'open';
  prompt: string;
  options?: string[];     // mcq: the choices
  answerIndex?: number;   // mcq: index into options
  modelAnswer?: string;   // open: the reference answer to grade against / reveal
  explanation?: string;   // why the answer is right (shown after submit)
}

export interface TeachResult {
  lessonNumber: number;
  title: string;
  docId: string;
  mission: string;
  missionCreated: boolean;
  body: string;
  covers: string;
  /** Interactive quiz for this lesson (may be empty if the model didn't produce one). */
  quiz: QuizQuestion[];
  /** Present only the first time a course syllabus is built — for the "course plan" preview. */
  syllabus?: SyllabusStep[];
  /** True once every syllabus step has a lesson. */
  courseComplete?: boolean;
}

const SYLLABUS_OPEN = '<!-- magpie:syllabus -->';

/** Extract the bodies of ```json / ``` fenced code blocks, in order. */
function fencedBlocks(raw: string): string[] {
  const out: string[] = [];
  const re = /```(?:json)?\s*([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw || '')) !== null) out.push(m[1].trim());
  return out;
}

/**
 * Parse a syllabus from LLM output (or a saved syllabus doc): the first fenced
 * JSON block that is an array (or `{steps:[…]}`) of `{title, covers, goal}`.
 * Steps are renumbered by order so `n` is always dense and 1-based. Returns []
 * on anything malformed — the caller then falls back to un-syllabused teaching.
 */
export function parseSyllabus(raw: string): SyllabusStep[] {
  for (const block of fencedBlocks(raw)) {
    try {
      const parsed = JSON.parse(block);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.steps) ? parsed.steps : null;
      if (!arr) continue;
      const out: SyllabusStep[] = [];
      for (const s of arr) {
        if (!s || typeof s.title !== 'string' || !s.title.trim()) continue;
        out.push({
          n: out.length + 1,
          title: s.title.trim().slice(0, 120),
          covers: String(s.covers ?? '').trim().slice(0, 300),
          goal: String(s.goal ?? '').trim().slice(0, 300),
        });
      }
      if (out.length >= 2) return out.slice(0, 8);
    } catch { /* try the next fence */ }
  }
  return [];
}

/** The next step to teach = the one whose number matches the next lesson. */
export function nextStep(prior: PriorLesson[], steps: SyllabusStep[]): SyllabusStep | null {
  if (steps.length === 0) return null;
  const n = nextLessonNumber(prior);
  return steps.find(s => s.n === n) ?? null;
}

/** Validate + normalize one quiz question; null if unusable. */
function normalizeQuestion(q: any): QuizQuestion | null {
  if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) return null;
  const prompt = q.prompt.trim().slice(0, 500);
  const explanation = typeof q.explanation === 'string' ? q.explanation.trim().slice(0, 500) : undefined;
  if (q.type === 'mcq') {
    const options = Array.isArray(q.options)
      ? q.options.map((o: any) => String(o).trim()).filter(Boolean).slice(0, 6)
      : [];
    const answerIndex = Number.isInteger(q.answerIndex) ? q.answerIndex : -1;
    if (options.length < 2 || answerIndex < 0 || answerIndex >= options.length) return null;
    return { type: 'mcq', prompt, options, answerIndex, explanation };
  }
  // Anything not a valid mcq is treated as an open question, IF it has a model answer.
  const modelAnswer = typeof q.modelAnswer === 'string' ? q.modelAnswer.trim()
    : typeof q.answer === 'string' ? q.answer.trim() : '';
  if (!modelAnswer) return null;
  return { type: 'open', prompt, modelAnswer: modelAnswer.slice(0, 800), explanation };
}

/**
 * Parse the quiz JSON block out of a model reply. Fails soft to [] so a lesson
 * is still delivered when the model omits or mangles the block — the quiz is a
 * bonus, never a gate on teaching.
 */
export function parseQuizBlock(raw: string): QuizQuestion[] {
  for (const block of fencedBlocks(raw)) {
    try {
      const parsed = JSON.parse(block);
      const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.questions) ? parsed.questions : null;
      if (!arr) continue;
      const out = arr.map(normalizeQuestion).filter(Boolean) as QuizQuestion[];
      if (out.length) return out.slice(0, 6);
    } catch { /* try the next fence */ }
  }
  return [];
}

export type GradeVerdict = 'correct' | 'partial' | 'incorrect';
export interface GradeResult { verdict: GradeVerdict; feedback: string }

/** Parse the grader's reply: "VERDICT: correct|partial|incorrect" + a why line. */
export function parseGrade(raw: string): GradeResult {
  const v = /verdict:\s*(correct|partial|incorrect)/i.exec(raw || '');
  const verdict = (v?.[1]?.toLowerCase() as GradeVerdict) || 'partial';
  const feedback = (raw || '')
    .replace(/^\s*verdict:.*$/im, '')
    .replace(/```[\s\S]*?```/g, '')
    .trim()
    .slice(0, 600) || 'No feedback returned.';
  return { verdict, feedback };
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

/**
 * Concatenated text of the workspace's RESEARCH (captures, reports) — never
 * lessons/syllabus. A course is built from what we actually gathered, so the
 * model teaches the material and cites it rather than relying on its own recall.
 */
export function researchSourceText(docs: Array<{ title: string; content: string }>, cap = 14000): string {
  const parts: string[] = [];
  for (const d of docs) {
    const type = frontmatterField(d.content, 'type');
    if (type === 'lesson' || type === 'syllabus') continue;
    const body = (splitFrontmatter(d.content).body || d.content).trim();
    if (body.length < 40) continue;
    parts.push(`# ${d.title}\n\n${body}`);
    if (parts.join('\n\n').length > cap) break;
  }
  return parts.join('\n\n---\n\n').slice(0, cap);
}

/** The saved course syllabus for this workspace, if one was built. */
export function findSyllabus(docs: Array<{ title: string; content: string }>): SyllabusStep[] {
  const doc = docs.find(d => frontmatterField(d.content, 'type') === 'syllabus');
  return doc ? parseSyllabus(doc.content) : [];
}

/** Ask the model to sequence the research into an easy-steps course. */
async function buildSyllabus(mission: string, sourceText: string): Promise<SyllabusStep[]> {
  const sys =
    'You design a short, well-sequenced course that teaches someone the material below IN EASY STEPS, ' +
    'building from fundamentals to the harder ideas. Each step is one finishable lesson.\n\n' +
    'Return ONLY a fenced ```json block: an array of 3-7 objects {"title","covers","goal"} where "title" ' +
    'names the step, "covers" lists the concepts it teaches (comma-separated), and "goal" is the one ' +
    'concrete thing the learner can DO after it. Order matters: earlier steps must not depend on later ' +
    'ones. No prose outside the JSON.';
  const user = `MISSION (why they are learning this):\n${mission}\n\nMATERIAL TO TEACH (their own research):\n${sourceText.slice(0, 14000)}`;
  const raw = await chatWithCustom(sys, [], user).catch(() => '');
  return parseSyllabus(raw);
}

/** A short retrieval-practice quiz for a just-written lesson. Fails soft to []. */
async function generateQuiz(topic: string, lessonTitle: string, lessonBody: string): Promise<QuizQuestion[]> {
  const sys =
    'You write a short retrieval-practice quiz for the lesson below: 3-5 questions that make the learner ' +
    'RECALL, not recognize.\n\nReturn ONLY a fenced ```json block: an array of question objects. Two allowed ' +
    'shapes:\n' +
    '- {"type":"mcq","prompt":"…","options":["…","…","…","…"],"answerIndex":0,"explanation":"why"} — the ' +
    'options MUST be similar in length so the answer cannot be guessed by shape.\n' +
    '- {"type":"open","prompt":"…","modelAnswer":"the concise correct answer","explanation":"what a good ' +
    'answer must contain"}\n' +
    'Mix both shapes. Base every question ONLY on the lesson. No prose outside the JSON.';
  const user = `TOPIC: ${topic}\nLESSON: ${lessonTitle}\n\n${lessonBody.slice(0, 6000)}`;
  const raw = await chatWithCustom(sys, [], user).catch(() => '');
  return parseQuizBlock(raw);
}

/** Grade a learner's free-text answer against the lesson's reference answer. */
export async function gradeAnswer(prompt: string, modelAnswer: string, userAnswer: string): Promise<GradeResult> {
  const sys =
    "You grade a learner's answer against the reference answer. Be fair: reward correct understanding even " +
    'when the wording differs; never demand exact phrasing.\n\nReply in EXACTLY this format:\n' +
    'VERDICT: correct | partial | incorrect\n' +
    '<one or two sentences: what was right, and the single most important thing to fix or add. Encouraging ' +
    'and specific; do not restate the whole answer.>';
  const user = `QUESTION: ${prompt}\n\nREFERENCE ANSWER: ${modelAnswer}\n\nLEARNER'S ANSWER: ${userAnswer}`;
  const raw = await chatWithCustom(sys, [], user);
  return parseGrade(raw);
}

async function writeLesson(
  mission: string, topic: string, lessonNumber: number, prior: PriorLesson[],
  pageContext?: { title: string; url: string; markdown: string },
  step?: SyllabusStep | null, sourceText?: string
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

  // When teaching a syllabus step, the step's goal IS the request; the research
  // material is the ground truth to teach from (report's "AI amplifies docs").
  const stepBlock = step
    ? `THIS STEP OF THE COURSE:\n- Title: ${step.title}\n- Teach: ${step.covers || step.title}\n- By the end they can: ${step.goal || 'apply this step'}\n\n`
    : '';
  const materialBlock = sourceText
    ? `\n\nMATERIAL (teach FROM this — it is the learner's own research; use its specifics, do not rely on your own recall):\n${sourceText.slice(0, 8000)}`
    : '';
  const user =
    `MISSION (why they are learning this):\n${mission}\n\n` +
    stepBlock +
    `LESSONS SO FAR:\n${history}\n\n` +
    `THIS REQUEST: ${step ? step.goal || step.title : (topic || '(no specific request — choose the best next lesson)')}` +
    (pageContext ? `\n\nCURRENT PAGE CONTEXT (the learner asked about this page — write the lesson around it):\nTitle: ${pageContext.title}\nURL: ${pageContext.url}\nContent:\n${pageContext.markdown.slice(0, 4000)}` : '') +
    materialBlock;

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
  let topic = String(request.topic || '').trim();
  const chatId = String(request.chatId || '');
  if (!projectId) throw new Error('No workspace selected');

  const project = await getProject(projectId);
  if (!project) throw new Error('Workspace not found');

  if (!topic && chatId) {
    const history = await getChatHistory(chatId).catch(() => []);
    const lastUser = [...history].reverse().find((m: any) => m.role === 'user' && !m.text.startsWith('/'));
    if (lastUser) {
      topic = lastUser.text.trim();
    }
  }

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

  // Build a course FROM the workspace's research the first time — so /teach
  // walks the report in easy steps instead of teaching from the model's recall.
  const sourceText = researchSourceText(docs);
  let syllabus = findSyllabus(docs);
  let syllabusJustBuilt: SyllabusStep[] | undefined;
  if (syllabus.length === 0 && sourceText.length > 400) {
    const built = await buildSyllabus(mission, sourceText);
    if (built.length >= 2) {
      const body = `${SYLLABUS_OPEN}\n\n# Course plan\n\n${built.map(s => `${s.n}. **${s.title}** — ${s.covers || s.goal}`).join('\n')}\n\n\`\`\`json\n${JSON.stringify(built)}\n\`\`\`\n`;
      const { id } = await saveDocument({
        title: 'Course plan', url: '', content: buildFrontmatter({ title: 'Course plan', type: 'syllabus', wordCount: built.length }) + body,
        capturedAt: new Date().toISOString(), favicon: '', wordCount: built.length, syncedToDrive: false,
      }, []).catch(() => ({ id: '' } as any));
      if (id) await linkDocumentToProject(projectId, id).catch(() => {});
      syllabus = built;
      syllabusJustBuilt = built;
    }
  }

  const step = nextStep(prior, syllabus);
  // Course finished: every step has a lesson. Report done rather than inventing more.
  if (syllabus.length > 0 && !step) {
    return {
      lessonNumber, title: '', docId: '', mission, missionCreated, covers: '', quiz: [],
      courseComplete: true,
      body: `You've completed all ${syllabus.length} steps of this course 🎉 Ask me anything you want to go deeper on, or start a new topic with \`/teach\`.`,
    } satisfies TeachResult as unknown as Record<string, unknown>;
  }

  const { title, covers, body } = await writeLesson(
    mission, topic, lessonNumber, prior, pageContext || undefined, step, step ? sourceText : undefined
  );

  // A retrieval-practice quiz for the chat layer (interactive). The saved lesson
  // keeps its own readable practice/answers; the quiz is a bonus, never a gate.
  const quiz = await generateQuiz(topic || step?.title || title, title, body);

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

  return { lessonNumber, title, docId, mission, missionCreated, body, covers, quiz, syllabus: syllabusJustBuilt } satisfies TeachResult as unknown as Record<string, unknown>;
}
