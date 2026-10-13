/**
 * Reply styling, enforced rather than requested.
 *
 * Small local models close almost every reply with a canned offer of help
 * ("How can I assist you today?"). Prompt instructions alone do not stop that,
 * so the filler is removed deterministically on the way out. The assistant still
 * streams: text is released sentence by sentence, and only a filler sentence is
 * dropped.
 */

/**
 * Sentences that are pure filler. These must match from the very start of the
 * sentence (after any bullet marker) so that real content which merely mentions
 * helping is never removed.
 */
const FILLER_START = new RegExp(
  "^(?:" +
    [
      "how (?:can|may|could) i (?:assist|help)(?: you)?(?: (?:today|now|here|with (?:that|anything else|anything|this)))?",
      "(?:is|was) there anything else(?: i can (?:help(?: you)? with|do)(?: for you)?)?",
      "anything else(?: i can (?:help(?: you)? with|do)(?: for you)?)?",
      "anything (?:else )?i can (?:help|do)(?: you)?(?: with)?",
      "(?:(?:please )?)?let me know if (?:you )?(?:need|have|want|there(?:'s| is| are))",
      "let me know (?:how it goes|what you think|if that (?:works|helps))",
      "feel free to (?:ask|reach out|let me know)",
      "i(?:'m| am) here (?:to help|if you need)",
      "happy to help(?: with (?:that|anything else))?",
      "(?:do you have|got) (?:any )?(?:other |further )?questions",
      "don'?t hesitate to (?:ask|reach out)",
      "just (?:let me know|ask)",
      "ask (?:me )?away",
      "what would you like (?:me )?to do next",
      "hope (?:that|this) helps",
      "(?:i )?(?:can|'ll|will) (?:help|assist) (?:you )?(?:with that|further|if you need)",
    ].join("|") +
    ")\\b",
  "i",
);

/** A filler "sentence" still has to be short; long text is treated as content. */
const MAX_FILLER_LENGTH = 120;

function isFillerSentence(sentence: string): boolean {
  const cleaned = sentence
    .replace(/^[\s*\-–—•>]+/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned === "" || cleaned.length > MAX_FILLER_LENGTH) return false;
  return FILLER_START.test(cleaned);
}

/** Any character that ends a "sentence" for filtering purposes. */
const TERMINATOR = /[.!?…\n]/;

export interface TrailingFilter {
  /** Feed a chunk; returns the text that is safe to show right now. */
  push(chunk: string): string;
  /** Release whatever is left, with any trailing filler removed. */
  flush(): string;
}

/**
 * Streams prose while holding back the current, possibly-incomplete sentence, so
 * that a filler sentence can be dropped whether or not it has finished yet.
 */
export function createTrailingFilter(): TrailingFilter {
  let pending = "";

  return {
    push(chunk: string): string {
      pending += chunk;
      let out = "";

      for (;;) {
        const match = TERMINATOR.exec(pending);
        if (!match) break;

        const end = match.index + 1;
        const sentence = pending.slice(0, end);
        pending = pending.slice(end);

        if (!isFillerSentence(sentence)) out += sentence;
      }

      return out;
    },

    flush(): string {
      const rest = pending;
      pending = "";
      if (rest.trim() === "" || isFillerSentence(rest)) return "";
      return rest.replace(/\s+$/, "");
    },
  };
}

/** Removes trailing (and mid-reply) filler sentences from a complete text. */
export function stripTrailingFiller(text: string): string {
  const filter = createTrailingFilter();
  return (filter.push(text) + filter.flush()).replace(/\s+$/, "");
}

export { isFillerSentence };
