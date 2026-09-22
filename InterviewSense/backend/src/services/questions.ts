import OpenAI from 'openai';
import { z } from 'zod';

export function getOfflineQuestions(role?: string): string[] {
  const cleanRole = role?.trim();
  if (!cleanRole) {
    return [
      'Tell me about yourself and your background.',
      'What are your greatest professional strengths and a key area for growth?',
      'Describe a challenging situation at work and how you handled it.',
      'Tell me about a time you worked on a team with differing opinions. How did you resolve it?',
      'Where do you see yourself professionally in the next few years?'
    ];
  }

  const lower = cleanRole.toLowerCase();
  if (lower.includes('software') || lower.includes('developer') || lower.includes('engineer') || lower.includes('frontend') || lower.includes('backend') || lower.includes('fullstack')) {
    return [
      `Tell me about yourself and your experience as a ${cleanRole}.`,
      'Describe a complex software project or system architecture you designed and built.',
      'How do you approach debugging a subtle production issue or performance bottleneck?',
      'Tell me about a technical disagreement with a teammate and how you resolved it.',
      'How do you ensure code quality, testing, and maintainability in a fast-moving team?'
    ];
  }

  if (lower.includes('product') || lower.includes('pm')) {
    return [
      `Tell me about yourself and your background in product management as a ${cleanRole}.`,
      'How do you prioritize competing feature requests from stakeholders and customers?',
      'Describe a time a product launch did not go as planned. What did you learn?',
      'How do you define success metrics and measure the impact of a new feature?',
      'Tell me about a time you had to make a tough product decision with incomplete data.'
    ];
  }

  if (lower.includes('data') || lower.includes('analytics') || lower.includes('analyst')) {
    return [
      `Tell me about yourself and your experience in data analysis or data science as a ${cleanRole}.`,
      'Describe a project where you translated complex data into actionable business insights.',
      'How do you handle dirty or missing data when building an analysis or model?',
      'Tell me about a time your data findings challenged stakeholders\' existing assumptions.',
      'How do you explain technical analytical results to a non-technical audience?'
    ];
  }

  return [
    `Tell me about yourself and your experience relevant to ${cleanRole}.`,
    `What interests you most about working as a ${cleanRole}?`,
    `Describe a difficult problem you solved as a ${cleanRole} and how you approached it.`,
    'Tell me about a time you received constructive feedback. How did you respond?',
    'What key skills do you bring to this role, and how do you plan to make an impact?'
  ];
}

const llmQuestionsSchema = z.object({
  questions: z.array(z.string().trim().min(5)).length(5)
}).strict();

export async function generateInterviewQuestions(role?: string): Promise<{ questions: string[]; questionSource: 'llm' | 'offline' }> {
  if (!process.env.OPENAI_API_KEY) {
    return { questions: getOfflineQuestions(role), questionSource: 'offline' };
  }

  const model = process.env.OPENAI_QUESTION_MODEL?.trim()
    || process.env.OPENAI_REPORT_MODEL?.trim()
    || 'gpt-4o-mini';

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const targetRole = role?.trim() || 'General Position';
    const completion = await openai.chat.completions.create({
      model,
      response_format: { type: 'json_object' },
      temperature: 0.5,
      max_tokens: 500,
      messages: [{
        role: 'user',
        content: `You are an expert interviewer. Generate exactly 5 realistic, targeted interview questions for a candidate applying for the role: "${targetRole}". Return a JSON object with key "questions" containing an array of exactly 5 non-empty string questions.`
      }]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) throw new Error('Empty completion from OpenAI');

    const parsed = llmQuestionsSchema.safeParse(JSON.parse(content));
    if (!parsed.success) throw new Error('Unexpected questions format from OpenAI');

    return { questions: parsed.data.questions, questionSource: 'llm' };
  } catch (error) {
    console.error('LLM question generation failed; falling back to offline question bank:', error);
    return { questions: getOfflineQuestions(role), questionSource: 'offline' };
  }
}
