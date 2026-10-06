/**
 * Everyday conversation that is not a question about the work: greetings, thanks, goodbyes,
 * "help", "start over", filler ("ummm") and bare yes/no. Rule-based chatbots famously break on
 * these; here they get an instant, friendly reply with no retrieval and no model call.
 */
export type SmallTalk = { kind: 'greeting' | 'thanks' | 'goodbye' | 'help' | 'reset' | 'filler'; reply: string };

const END = String.raw`[\s.!?,:)]*$`;
const RULES: [SmallTalk['kind'], RegExp, string][] = [
  [
    'greeting',
    new RegExp(String.raw`^(hi|hello|hey|heya|hiya|yo|g'?day|howdy|good (morning|afternoon|evening))( there)?${END}`, 'i'),
    "Hi! Ask me anything about Rishabh's work: his projects, skills, experience, or how he builds things.",
  ],
  [
    'thanks',
    new RegExp(String.raw`^(thanks|thank you|thx|ty|cheers|ta|great|cool|nice|awesome|perfect|ok(ay)?|got it|makes sense)( (so much|a lot|mate))?${END}`, 'i'),
    'Glad that helped. Anything else you would like to know about his work?',
  ],
  [
    'goodbye',
    new RegExp(String.raw`^(bye|goodbye|good bye|see ya|see you|later|cya|that'?s all|i'?m done|done)${END}`, 'i'),
    'Thanks for stopping by. To talk to Rishabh himself, email hi@rishabhray.me.',
  ],
  [
    'help',
    new RegExp(String.raw`^(help|\?+|menu|options|agent|support|what can (i|you) (ask|do)|what do i ask|how does this work)${END}`, 'i'),
    'You can ask about his projects (NeighbourFit, Outfit Picker, RAY/OS and the smaller demos), his skills, his experience, or how to reach him. The suggestions below are a good start.',
  ],
  [
    'reset',
    new RegExp(String.raw`^(reset|start over|restart|clear|new chat|begin again)${END}`, 'i'),
    'Fresh start. What would you like to know about Rishabh?',
  ],
  [
    'filler',
    new RegExp(String.raw`^(u+m+|h+m+|o+h+|a+h+|e+r+m*|u+h+|yes|yeah|yea|ya|yep|yup|no|nope|nah|maybe|idk|dunno|what|huh|lol|k)${END}`, 'i'),
    "No rush. You could ask what he's building right now, or about any of his projects.",
  ],
];

export function smallTalk(question: string, replies?: Partial<Record<SmallTalk['kind'], string>>): SmallTalk | null {
  const q = question.trim();
  if (q.length > 40) return null;
  for (const [kind, pattern, reply] of RULES) if (pattern.test(q)) return { kind, reply: replies?.[kind] ?? reply };
  return null;
}
