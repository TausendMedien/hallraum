// Spoken-language data used for transcripts: filler words and (later) auto-cut rules.
// German is the first fully supported language next to English.
// To add a language, add an entry here and a Whisper prompt in worker/worker.py.

export const LANGUAGES = {
  en: {
    name: 'English',
    // Pure hesitation sounds: always safe to mark (and later cut)
    fillers: ['uh', 'um', 'uhm', 'umm', 'erm', 'er', 'ah', 'hmm', 'hm', 'mm', 'mhm'],
    // Words that are often filler but also real words: only removed at higher auto-cut levels
    softFillers: ['like', 'basically', 'actually', 'literally', 'you know', 'i mean', 'sort of', 'kind of', 'so'],
  },
  de: {
    name: 'Deutsch',
    // Note: "um" is a real German word (um … zu), so it is NOT in this list
    fillers: ['äh', 'ähm', 'öh', 'öhm', 'äm', 'ähh', 'ähmm', 'eh', 'hm', 'hmm', 'mhm', 'mh'],
    softFillers: ['also', 'halt', 'eben', 'sozusagen', 'quasi', 'irgendwie', 'gell', 'ne', 'ja', 'genau', 'eigentlich', 'praktisch'],
  },
};

export const normWord = (w) => String(w).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function languageData(lang) {
  return LANGUAGES[lang] || LANGUAGES[String(lang || '').slice(0, 2)] || LANGUAGES.en;
}

// Only the list of the detected language is used: a filler in one language can be a word in another
export function isFiller(word, lang) {
  return languageData(lang).fillers.includes(normWord(word));
}

export function isSoftFiller(word, lang) {
  return languageData(lang).softFillers.includes(normWord(word));
}
