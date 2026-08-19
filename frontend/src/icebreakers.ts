/**
 * Conversation prompts.
 *
 * Purely client-side copy. Nothing here is sent anywhere until the user picks
 * one, and a picked prompt goes out as an ordinary message through the normal
 * path — moderation, rate limiting, retention and all. There is no separate
 * channel for these and no server involvement in choosing them.
 */
export interface IcebreakerCategory {
  readonly category: string;
  readonly prompts: readonly string[];
}

export const ICEBREAKERS: readonly IcebreakerCategory[] = [
  {
    category: 'Funny',
    prompts: [
      "What's the most useless talent you have?",
      "What's your worst haircut story?",
      "What's a conspiracy theory you kind of believe?",
    ],
  },
  {
    category: 'Deep',
    prompts: [
      "What's something you could talk about for hours?",
      "What's a small decision that changed your life?",
      'What do you wish more people understood about you?',
    ],
  },
  {
    category: 'Random',
    prompts: [
      'If you could have dinner with anyone, dead or alive, who?',
      "What's the last thing that made you laugh out loud?",
      "What's your go-to comfort food?",
    ],
  },
  {
    category: 'Would you rather',
    prompts: [
      'Would you rather always be 10 minutes late or 20 minutes early?',
      'Would you rather have unlimited sushi or unlimited tacos?',
      'Would you rather time travel to the past or the future?',
    ],
  },
  {
    category: 'Hypothetical',
    prompts: [
      'If you could live anywhere in the world, where would it be?',
      'If you had to teach a college class on anything, what would it be?',
      'If you could master one skill instantly, what would you pick?',
    ],
  },
  {
    category: 'Travel',
    prompts: [
      "What's the best trip you've ever taken?",
      'Where would you go right now if you could teleport?',
      "What's a place everyone should visit at least once?",
    ],
  },
  {
    category: 'Gaming',
    prompts: [
      'What game did you lose too many hours to?',
      "What's a game everyone should try at least once?",
      "What's your hottest gaming opinion?",
    ],
  },
  {
    category: 'Food',
    prompts: [
      "What's a food combination you love that others find weird?",
      "What's your go-to late-night snack?",
      "What's the best meal you've ever had?",
    ],
  },
];
