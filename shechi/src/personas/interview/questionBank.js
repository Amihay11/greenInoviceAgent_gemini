// Templates per gap_kind. Each returns an array of {q} objects.

export const BANK = {
  domain_unknown: (subject) => [
    { q: `How would you describe your background in ${subject}?` },
    { q: `On a 0–10 scale, how confident are you in ${subject} today?` },
    { q: `Any sub-areas inside ${subject} I should tag for cross-pollination later?` },
  ],
  mastery_unknown: (subject) => [
    { q: `On a 0–10 scale, how comfortable are you with ${subject}?` },
    { q: `What's the last concept in ${subject} you confidently used?` },
    { q: `What's the first concept that still feels fuzzy?` },
  ],
  preference_unknown: (subject) => [
    { q: `When ${subject} comes up, what does your "good answer" usually look like?` },
    { q: `What style of response do you NOT want for this kind of question?` },
  ],
  goal_unclear: (subject) => [
    { q: `Quick check — what's the actual goal behind "${subject}"?` },
    { q: `What does "done" look like for this goal?` },
    { q: `Time horizon — weeks, months, or years?` },
  ],
  rule_unknown: (subject) => [
    { q: `Should I treat "${subject}" as a permanent preference or a one-off?` },
    { q: `In what situations does this rule NOT apply?` },
  ],
};

export function questionsFor(gap) {
  const factory = BANK[gap.gap_kind];
  if (!factory) return [];
  return factory(gap.gap_subject);
}
