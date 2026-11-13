/**
 * The assistant's keyword matcher — pure, no database. It maps what a shopper typed to ONE of the store's verified
 * routes: a danger sign, an approved troubleshooting tree (by symptom key), a topic (an article tag) or an error code.
 * It does not understand language; it looks for the words below (Arabic as written in Iraq, English, Kurdish Sorani)
 * and says so on the page. Whatever it returns can only select approved content.
 *
 * The vocabulary is routing data, not facts: adding a word can only send a shopper to a guide that already exists.
 */

/** Signs that mean "stop and get a technician": checked before anything else. */
const DANGER_TERMS = [
  // en
  "smoke", "smoking", "burning", "burnt", "burn smell", "sparks", "spark", "fire", "flames", "swollen", "swelling", "bulging", "bloated", "liquid", "water damage", "spilled", "spill", "electric shock",
  // ar
  "دخان", "يدخن", "احتراق", "رائحه حرق", "ريحه حرق", "ريحه شياط", "شياط", "شرار", "شراره", "حريق", "نار", "منتفخ", "منتفخه", "انتفاخ", "نفخت", "سائل", "انسكب", "ماي", "ماء", "مي", "كهربني", "صعقه",
  // ckb
  "دووکەڵ", "بۆنی سووتان", "سووتان", "پریشک", "ئاگر", "ئاوساو", "ئاوسان", "شلە", "ئاو", "کارەبا لێیدام",
];

/** Words per symptom key of a troubleshooting tree (trees are matched by key; a key with no approved tree is ignored). */
const SYMPTOM_TERMS: Record<string, string[]> = {
  stick_drift: [
    "drift", "drifting", "drifts", "stick", "sticks", "joystick", "thumbstick", "analog", "analogue", "joy-con", "joycon", "moves by itself", "moves on its own", "moving on its own", "camera moves",
    "انحراف", "ينحرف", "تنحرف", "منحرف", "منحرفه", "عصا", "عصاه", "جويستك", "جوستك", "جويستيك", "انالوج", "يتحرك وحده", "تتحرك وحدها", "يمشي وحده", "تمشي وحدها", "الكاميرا تتحرك",
    // "joy-con" the way it is written in Arabic (the Latin spellings above already point here)
    "جويكون", "جوي كون",
    "لادان", "لادەدات", "لادەدا", "جۆیستیک", "خۆی دەجووڵێت", "خۆی دەڕوات",
  ],
  no_power: [
    "wont turn on", "will not turn on", "doesnt turn on", "does not turn on", "not turning on", "no power", "dead", "wont start", "will not start", "doesnt start", "does not start", "no light", "shuts off", "shuts down", "turns off", "switches off", "black screen", "no picture", "no signal", "no display", "no image", "hdmi",
    "لا يشتغل", "ما يشتغل", "مايشتغل", "لا يعمل", "ما يعمل", "مايعمل", "لا يفتح", "ما يفتح", "مايفتح", "لا يشتعل", "ما يشتعل", "ميت", "طافي", "ينطفئ", "ينطفي", "يطفي", "يطفى", "يطفا", "شاشه سوداء", "شاشه سودا", "لا صوره", "ماكو صوره", "ماكو شي", "لا توجد صوره", "بدون صوره", "لا اشاره", "ماكو اشاره",
    "داناگیرسێت", "داناگیرسیت", "ناگیرسێت", "دەکوژێتەوە", "دەکوژیتەوە", "کار ناکات", "کارناکات", "شاشەی ڕەش", "وێنە نییە", "هیچ وێنەیەک نییە",
  ],
};

/** Words per topic; a topic is an article tag (only approved articles carrying it are offered). */
const TOPIC_TERMS: Record<string, string[]> = {
  overheating: [
    "hot", "heat", "heats", "overheat", "overheating", "overheats", "fan", "loud", "noise", "noisy",
    "حراره", "حار", "حاره", "يسخن", "تسخن", "سخونه", "يحمى", "مروحه", "مروحت", "صوت عالي", "صوت مزعج", "ضجيج", "يزعج",
    "گەرم", "گەرمی", "گەرم دەبێت", "پانکە", "دەنگی بەرز", "دەنگەدەنگ",
  ],
  controller: [
    "controller", "gamepad", "pad", "pair", "pairing", "bluetooth", "disconnects",
    "يد التحكم", "ايد التحكم", "دراع", "ذراع", "الدراعات", "اقتران", "بلوتوث", "ما يقترن", "يفصل",
    "دەسک", "دەسکی یاری", "جووتکردن", "بلوتوز",
  ],
  display: [
    "screen", "display", "picture", "flicker", "flickering", "resolution",
    "شاشه", "الشاشه", "صوره", "يرمش", "ترمش", "دقه",
    "شاشە", "وێنە", "لەرزین",
  ],
  battery: [
    "battery", "charge", "charging", "charger", "wont charge", "drains",
    "بطاريه", "شحن", "يشحن", "ما يشحن", "شاحن", "الشاحن", "تخلص البطاريه",
    "پاتری", "بارگاوی", "بارگاویکەر", "شەحن",
  ],
  setup: [
    "setup", "set up", "first time", "new console", "transfer data", "data transfer", "install", "account",
    "تجهيز", "اعداد", "اول مره", "لاول مره", "جهاز جديد", "نقل البيانات", "تثبيت", "حساب",
    "ئامادەکردن", "یەکەم جار", "گواستنەوەی داتا", "هەژمار",
  ],
};

/** Error-code shapes of the platforms (PlayStation CE-108255-1 / E-8210604A, Xbox 0x80070005 / E101, Nintendo 2123-1502). */
const CODE_PATTERNS: RegExp[] = [/\b([A-Z]{2,3}-\d{5,6}-\d)\b/, /\b(E-[0-9A-F]{8})\b/, /\b(0X[0-9A-F]{8})\b/, /\b(\d{4}-\d{4})\b/, /\b(E[12]\d{2})\b/];

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Lower case, Arabic letter variants unified, diacritics and tatweel removed, digits Latin, punctuation → spaces. */
export function normalizeForMatch(input: string): string {
  let out = "";
  for (const ch of input.toLowerCase()) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    out += ch;
  }
  return out
    .replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ک/g, "ك")
    .replace(/[’'`]/g, "")
    .replace(/[^\p{L}\p{N}-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const PREFIXES = ["وال", "بال", "فال", "كال", "لل", "ال", "و", "ب", "ف", "ل", "ك"];
const isLatin = (term: string) => /[a-z]/.test(term);

function compile(terms: readonly string[]): string[] {
  return [...new Set(terms.map(normalizeForMatch).filter(Boolean))];
}

/**
 * Whether a word of the text (`token`) is the term, the term with an Arabic article or conjunction in front, or the
 * term with a short ending. Both sides normalised (normalizeForMatch). Exported for the help-centre search.
 */
export function tokenMatches(token: string, term: string): boolean {
  if (token === term) return true;
  // Arabic words carry their article and conjunctions in front: "والعصا", "بالشاشه".
  if (!isLatin(term) && PREFIXES.some((prefix) => token === prefix + term)) return true;
  // Endings ("drifting", "joysticks", Sorani "پانکەکە") — only for terms long enough not to catch other words.
  if (term.length >= 4 && token.startsWith(term) && token.length - term.length <= 4) return true;
  if (!isLatin(term) && term.length >= 3 && PREFIXES.some((prefix) => token.startsWith(prefix + term) && token.length - prefix.length - term.length <= 3)) return true;
  return false;
}

function countMatches(text: string, tokens: readonly string[], terms: readonly string[]): number {
  let hits = 0;
  for (const term of terms) {
    if (term.includes(" ")) {
      if (` ${text} `.includes(` ${term} `) || (!isLatin(term) && text.includes(term))) hits++;
    } else if (tokens.some((token) => tokenMatches(token, term))) {
      hits++;
    }
  }
  return hits;
}

const DANGER = compile(DANGER_TERMS);
const SYMPTOMS = Object.entries(SYMPTOM_TERMS).map(([key, terms]) => ({ key, terms: compile(terms) }));
const TOPICS = Object.entries(TOPIC_TERMS).map(([key, terms]) => ({ key, terms: compile(terms) }));

export type Interpretation =
  | { kind: "danger" }
  | { kind: "symptom"; symptomKey: string }
  | { kind: "code"; code: string }
  | { kind: "topic"; topic: string }
  | { kind: "none" };

/** A text as the code patterns read it: upper case, Arabic-Indic digits Latin, long dashes as hyphens. */
const codeText = (text: string) => text.toUpperCase().replace(/[٠-٩]/g, (d) => String(ARABIC_INDIC.indexOf(d))).replace(/[–—]/g, "-");
/** A matched code as the store writes it: "0X80070005" → "0x80070005", others as they are (upper case). */
const codeOf = (match: string) => (match.startsWith("0X") ? `0x${match.slice(2)}` : match);

/** The error code in a text, upper case ("CE-108255-1", "0X80070005" → "0x80070005"), or null. */
export function findErrorCode(text: string): string | null {
  const upper = codeText(text);
  for (const pattern of CODE_PATTERNS) {
    const match = pattern.exec(upper);
    if (match) return codeOf(match[1]);
  }
  return null;
}

/**
 * Every error code a text mentions (a guide's body — the help centre's search index lists them, so a code typed in the
 * search box opens the guides that name it), each once, in the order of the patterns. Same shapes as findErrorCode.
 */
export function findErrorCodes(text: string): string[] {
  const upper = codeText(text);
  const found = new Set<string>();
  for (const pattern of CODE_PATTERNS) {
    for (const match of upper.matchAll(new RegExp(pattern.source, "g"))) found.add(codeOf(match[1]));
  }
  return [...found];
}

/**
 * What the shopper's words point to, in this order: a danger sign (always first), an error code, the symptom with the
 * most matching words (only among `symptoms` — the keys that have an approved tree for this device), then a topic.
 */
export function interpretText(text: string, available: { symptoms: readonly string[] }): Interpretation {
  const normalized = normalizeForMatch(text);
  if (!normalized) return { kind: "none" };
  const tokens = normalized.split(" ");
  if (countMatches(normalized, tokens, DANGER) > 0) return { kind: "danger" };
  const code = findErrorCode(text);
  if (code) return { kind: "code", code };

  let best: { key: string; hits: number } | null = null;
  for (const symptom of SYMPTOMS) {
    if (!available.symptoms.includes(symptom.key)) continue;
    const hits = countMatches(normalized, tokens, symptom.terms);
    if (hits > 0 && (!best || hits > best.hits)) best = { key: symptom.key, hits };
  }
  let topic: { key: string; hits: number } | null = null;
  for (const entry of TOPICS) {
    const hits = countMatches(normalized, tokens, entry.terms);
    if (hits > 0 && (!topic || hits > topic.hits)) topic = { key: entry.key, hits };
  }
  // A symptom wins ties: a tree walks the shopper through checks, a topic only lists guides.
  if (best && (!topic || best.hits >= topic.hits)) return { kind: "symptom", symptomKey: best.key };
  if (topic) return { kind: "topic", topic: topic.key };
  if (best) return { kind: "symptom", symptomKey: best.key };
  return { kind: "none" };
}

export const KNOWN_TOPICS = Object.keys(TOPIC_TERMS);

/** Symptom keys the vocabulary knows (a key is only offered when an approved tree has it). */
export const KNOWN_SYMPTOMS = Object.keys(SYMPTOM_TERMS);

/** A danger sign in the text (smoke, burning, swelling, liquid …) — always checked before anything else. */
export function hasDangerSign(text: string): boolean {
  const normalized = normalizeForMatch(text);
  return normalized !== "" && countMatches(normalized, normalized.split(" "), DANGER) > 0;
}

/** The text says what is wrong (a danger sign, an error code, a symptom or a topic), not only which device it is. */
export function describesProblem(text: string): boolean {
  return interpretText(text, { symptoms: KNOWN_SYMPTOMS }).kind !== "none";
}

// ───────────────────────────────────────────────────────────────── device and platform names

/**
 * How shoppers write device and platform names (Arabic as written in Iraq, Sorani), mapped to the catalogue's own
 * Latin words. Routing data like the vocabulary above: it can only point at a device of the published directory.
 */
const NAME_ALIASES: ReadonlyArray<readonly [readonly string[], string]> = [
  [["بلاي ستيشن", "بلايستيشن", "بلاستيشن", "بليستيشن", "بلي ستيشن", "بلستيشن", "پلەیستەیشن", "پلەی ستەیشن", "سوني", "بي اس", "ps"], "playstation"],
  [["ps5", "بلي5"], "playstation 5"],
  [["ps4"], "playstation 4"],
  [["اكس بوكس", "اكسبوكس", "اكس بكس", "ئێکس بۆکس", "ئێکسبۆکس"], "xbox"],
  [["نينتندو", "نينتيندو", "ننتندو", "نینتێندۆ"], "nintendo"],
  [["سويتش", "سويچ", "سوتش", "سويج", "سويتج", "سوێچ"], "switch"],
  [["ستيم ديك", "ستيم دك", "ستيمديك", "steamdeck", "ستیم دێک"], "steam deck"],
  [["في ار 2", "في ار", "vr 2", "vr"], "vr2"],
  [["بورتال", "بورتل", "پۆرتاڵ"], "portal"],
  [["سيريس", "سيريز", "سيرس", "سریس", "سێریس"], "series"],
  [["روغ", "روج"], "rog"],
  [["الاي", "اللاي", "ئالای"], "ally"],
  [["ليجن", "ليجين", "لجن"], "legion"],
  [["كلو", "كلاو"], "claw"],
  [["برو", "پرۆ"], "pro"],
  [["سليم", "سلم", "سلیم"], "slim"],
  [["لايت", "لایت"], "lite"],
  [["اوليد", "او ليد", "ئۆلید"], "oled"],
  [["ال سي دي"], "lcd"],
  [["ديجيتال", "دجيتال", "ديجتال", "ديجيتل", "رقمي", "رقميه", "دیجیتاڵ"], "digital"],
  [["اكس", "ئێکس"], "x"],
  [["اس", "ئێس"], "s"],
];

/** Normalised alias → its words, longest first so "اكس بوكس" is read before "اكس". */
const ALIASES: ReadonlyArray<readonly [string, string]> = NAME_ALIASES.flatMap(([spellings, words]) => spellings.map((spelling) => [normalizeForMatch(spelling), words] as const))
  .filter(([spelling]) => spelling !== "")
  .sort((a, b) => b[0].length - a[0].length);

/** Words that may be left out of a device's name ("Nintendo Switch Lite" is "سويتش لايت"). */
const OPTIONAL_NAME_WORDS = new Set(["nintendo", "lenovo", "msi", "edition", "model", "the", "console", "الطراز", "جهاز"]);

/** Words that make a variant of a model: a name that only lacks these is not specific enough ("Switch" vs "Switch Lite"). */
const VARIANT_WORDS = new Set(["digital", "slim", "lite", "oled", "lcd", "pro", "x", "s", "2", "plus", "ai", "ex", "8", "a8"]);

/** «البلايستيشن» → «بلايستيشن»: an Arabic article or conjunction in front of a name (the rest keeps ≥ 3 letters). */
const NAME_PREFIX = /^(وال|بال|فال|كال|لل|ال|و|ب)(?=[^\s]{3,}$)/;

/**
 * The catalogue's words for the device and platform names a text spells the way shoppers write them («بلايستيشن» →
 * "playstation", «سويتش لايت» → "switch", "lite", "ps5" → "playstation", "5"), each once — with an Arabic article or
 * conjunction in front of the name too («البلايستيشن»). The help centre's search adds them to the shopper's own words,
 * so «تجهيز البلايستيشن» finds "PlayStation 5" guides. Routing data: it can only point at names that exist. Pure.
 */
export function aliasWords(text: string): string[] {
  const normalized = normalizeForMatch(text);
  if (!normalized) return [];
  const bare = ` ${normalized
    .split(" ")
    .map((token) => token.replace(NAME_PREFIX, ""))
    .join(" ")} `;
  const plain = ` ${normalized} `;
  const out = new Set<string>();
  for (const [spelling, words] of ALIASES) {
    if (plain.includes(` ${spelling} `) || bare.includes(` ${spelling} `)) for (const word of words.split(" ")) out.add(word);
  }
  // "ps5" / "playstation5" glued to its digit
  for (const match of normalized.matchAll(/\b(?:ps|playstation|switch)(\d)\b/g)) {
    out.add(match[0].startsWith("switch") ? "switch" : "playstation");
    out.add(match[1]);
  }
  return [...out];
}

/** The text's words with every known spelling of a name replaced by the catalogue's words. */
function nameWords(text: string): string[] {
  let out = ` ${normalizeForMatch(text)} `;
  for (const [spelling, words] of ALIASES) out = out.split(` ${spelling} `).join(` ${words} `);
  // "ps5" written with a space or glued to its digit: "playstation5" → "playstation 5"
  return out.replace(/\b(playstation|switch|vr)(\d)/g, "$1 $2").trim().split(" ").filter(Boolean);
}

export type NamedDevice = { kind: "device"; slug: string } | { kind: "platform"; slug: string } | { kind: "none" };

type DirectoryLike = ReadonlyArray<{ slug: string; devices: ReadonlyArray<{ slug: string; name: string }> }>;

const PLATFORM_WORDS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["handheld", ["steam", "deck", "rog", "ally", "legion", "claw", "msi"]],
  ["playstation", ["playstation"]],
  ["xbox", ["xbox"]],
  ["nintendo", ["nintendo", "switch"]],
];

/**
 * The device (or only the platform) a shopper's words name, from the published directory: a device whose every
 * required name word is in the text; the most specific one wins. A name that another device's name extends ("PS5
 * Slim" → "PS5 Slim Digital Edition", "Switch" → "Switch Lite") or a tie is not decided here: only its platform is,
 * and the assistant asks for the model. Pure.
 */
export function matchDevice(text: string, directory: DirectoryLike): NamedDevice {
  const words = new Set(nameWords(text));
  if (words.size === 0) return { kind: "none" };
  const devices = directory.flatMap((group) => group.devices.map((device) => ({ slug: device.slug, platform: group.slug, required: [...new Set(nameWords(device.name))].filter((word) => !OPTIONAL_NAME_WORDS.has(word)) })));
  const candidates = devices.filter((device) => device.required.length > 0 && device.required.every((word) => words.has(word))).sort((a, b) => b.required.length - a.required.length);
  const best = candidates[0];
  if (best) {
    const tie = candidates.filter((device) => device.required.length === best.required.length);
    const extended = devices.some(
      (device) =>
        device.slug !== best.slug &&
        device.required.length > best.required.length &&
        best.required.every((word) => device.required.includes(word)) &&
        device.required.every((word) => best.required.includes(word) || VARIANT_WORDS.has(word)),
    );
    if (tie.length === 1 && !extended) return { kind: "device", slug: best.slug };
    const platforms = new Set(tie.map((device) => device.platform));
    if (platforms.size === 1) return { kind: "platform", slug: best.platform };
  }
  for (const [platform, keys] of PLATFORM_WORDS) {
    if (!directory.some((group) => group.slug === platform)) continue;
    if (keys.some((key) => words.has(key))) return { kind: "platform", slug: platform };
  }
  return { kind: "none" };
}
