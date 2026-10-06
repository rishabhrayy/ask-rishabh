import { ALLOWED_HOST } from './outputguard.ts';
import { LEAK_SIGNATURES, SYSTEM_PROMPT } from './prompt.ts';
import type { SmallTalk } from './smalltalk.ts';

/**
 * Everything that makes an assistant about one subject rather than another: what the model is
 * told, which topics are off-limits, and the wording of refusals and small talk. The engine
 * (retrieval, guard, canary, output check, fallbacks) stays the same across subjects.
 */
export type Domain = {
  systemPrompt: string;
  /** Phrases that only exist in systemPrompt; seeing one in an answer means it is leaking */
  leakSignatures: string[];
  /** Refuse salary, age, relationships and similar? Off where pay itself is the subject */
  privateTopics: boolean;
  /** Reply to an injection or encoding attempt */
  scopeReply: string;
  /** Reply to a private question (when privateTopics is on) */
  privateReply: string;
  /** Reply when search finds nothing and no overview passages are set */
  notFound: string;
  /** Replaces an answer the output check withheld */
  blockedReply: string;
  smallTalk: Record<SmallTalk['kind'], string>;
  /** Hosts an answer may link to; any other link means the answer is withheld */
  allowedHosts: RegExp;
  /** Opens the no-model answer shown when every provider is down */
  fallbackIntro: string;
};

const CONTACT = 'For anything else, email hi@rishabhray.me.';

/** The assistant on rishabhray.me: questions about Rishabh's work, from the site's own pages. */
export const SITE_DOMAIN: Domain = {
  systemPrompt: SYSTEM_PROMPT,
  leakSignatures: LEAK_SIGNATURES,
  privateTopics: true,
  scopeReply: `I only answer questions about Rishabh's work, using what is on this site. ${CONTACT}`,
  privateReply: `That is not something I answer here. I stick to Rishabh's work, projects and skills. ${CONTACT}`,
  notFound: `I couldn't find that on the site. It covers Rishabh's projects, skills, experience and how he works. ${CONTACT}`,
  blockedReply: `I can't help with that here. I only answer questions about Rishabh's work, using what is on this site. ${CONTACT}`,
  allowedHosts: ALLOWED_HOST,
  fallbackIntro: 'The AI model is unavailable right now, so here is what the site says:',
  smallTalk: {
    greeting: "Hi! Ask me anything about Rishabh's work: his projects, skills, experience, or how he builds things.",
    thanks: 'Glad that helped. Anything else you would like to know about his work?',
    goodbye: 'Thanks for stopping by. To talk to Rishabh himself, email hi@rishabhray.me.',
    help: 'You can ask about his projects (NeighbourFit, Outfit Picker, RAY/OS and the smaller demos), his skills, his experience, or how to reach him. The suggestions below are a good start.',
    reset: 'Fresh start. What would you like to know about Rishabh?',
    filler: "No rush. You could ask what he's building right now, or about any of his projects.",
  },
};

export const resolveDomain = (overrides?: Partial<Domain>): Domain => ({
  ...SITE_DOMAIN,
  ...overrides,
  smallTalk: { ...SITE_DOMAIN.smallTalk, ...overrides?.smallTalk },
});
