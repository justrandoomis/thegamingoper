/**
 * The maintenance assistant (brief §7, DESIGN.md §9.22) — a GUIDED assistant over TamTam's approved troubleshooting
 * trees and articles. No AI model or provider is configured; nothing here generates text. Every sentence the shopper
 * reads comes from an approved tree or article, or from the page's own fixed wording (the "support" messages).
 *
 *   const view = await runAssistant(db, locale, parseAssistantState(url.searchParams));
 *   const ticket = await handOffToStaff(db, who, locale, state, { idempotencyKey, phone, contactName, note, consent }, ctx.now, { store, photos });
 *
 * How a conversation runs (its state is the URL, see ./state.ts):
 *   device      platform → model, or "not in the list"
 *   problem     an approved tree's symptom, or the shopper's own words (`q`): the keyword matcher (./matcher.ts) routes
 *               them to a danger stop, an error code, a tree or a topic — or says plainly that it found nothing
 *   steps       the tree is replayed from its start with the answers given; each node is a question, a safe step (its
 *               warning first) or an outcome
 *   done        resolved · a device guide · a part · book a repair · talk to staff
 * Uncertainty is stated in words (AssistantConfidence). A description alone never yields a hardware diagnosis: the
 * trees say "most likely" and send anything unsolved to a technician; danger words stop the conversation at once.
 *
 * THE MODEL BOUNDARY. `AssistantModel` is where a language model can be plugged in later. It may only map the shopper's
 * words to keys that already exist (an approved symptom tree or a topic), so it can never invent a repair step; danger
 * signs and error codes are never left to it. `configuredAssistantModel()` returns null — nothing is configured — and
 * the page says that the answers come from TamTam's verified guides, not from an AI diagnosis.
 *
 * Handoff (talk to staff) needs the shopper's consent; only then is anything stored: an `assistant_sessions` row
 * (status "escalated", log_consent = 1), the transcript as `assistant_messages`, a "support_log" consent, and a support
 * ticket whose internal note is the summary (in Arabic, for staff) — ONE batch. Without a handoff nothing is stored.
 */
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { serverT } from "~/i18n/i18n.server";
import type { TFunction } from "~/i18n/translate";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { assistantMessages, assistantSessions, consents, troubleshootingTrees, type NewAssistantMessage, type TroubleshootingNode, type TroubleshootingTree } from "~/server/db/schema";
import { chunkRows, isDbError, runBatch } from "~/server/db/tx.server";
import { invalid, zodFieldErrors } from "~/server/errors";
import type { BlobStore } from "~/server/storage.server";
import { cleanLine } from "~/server/text.server";
import type { UploadSource } from "~/server/uploads.server";
import { accessTokenHash, actorOf, discardPhotos, isIdempotencyKey, photoSources, preparePhotos, storePhotos, supportAccessToken, type SupportWho } from "./common.server";
import { findArticlesMentioning, findDevice, findPlatform, getSupportDirectory, listArticlesByTag, listArticlesForDevice, listArticlesForPlatform, listHelpArticles } from "./kb.server";
import { interpretText, KNOWN_TOPICS, type Interpretation } from "./matcher";
import { DEVICE_OTHER, assistantSearch, type AssistantState } from "./state";
import { summarizeConversation } from "./summary";
import { enforceSupportLimits, existingTicket, fileRowStatements, newTicketIdentity, optionalText, phoneOf, planSupportTicket, ticketGuard } from "./tickets.server";
import type {
  ArticleSummary,
  AssistantBotTurn,
  AssistantChoice,
  AssistantConfidence,
  AssistantOutcome,
  AssistantPrompt,
  AssistantTurn,
  AssistantUserTurn,
  AssistantView,
  CreatedTicket,
  SupportDevice,
  SupportPlatform,
} from "./types";

// ───────────────────────────────────────────────────────────────── the model boundary

/**
 * A language model that reads the shopper's words. It may only answer with keys from `allowed` — anything else is
 * ignored — so the steps a shopper sees always come from approved trees and articles.
 */
export interface AssistantModel {
  readonly name: string;
  interpret(input: {
    text: string;
    locale: Locale;
    device: string | null;
    allowed: { symptoms: readonly string[]; topics: readonly string[] };
  }): Promise<{ symptomKey?: string; topic?: string } | null>;
}

/** The configured model, or null. None is configured: no provider, no key, no endpoint. */
export function configuredAssistantModel(): AssistantModel | null {
  return null;
}

// ───────────────────────────────────────────────────────────────── trees

type LoadedTree = {
  id: string;
  symptomKey: string;
  title: L10n;
  deviceModelId: string | null;
  platformId: string | null;
  isDemo: boolean;
  start: string;
  nodes: Map<string, TroubleshootingNode>;
};

const NODE_KINDS = new Set(["question", "step", "outcome"]);
const OUTCOME_TYPES = new Set(["resolved", "article", "part", "repair", "human"]);
const isL10n = (value: unknown): value is L10n => typeof value === "object" && value !== null && typeof (value as L10n).ar === "string" && (value as L10n).ar.trim() !== "";

/** A tree that can be walked safely — every node well formed, every option leads to a node, the start exists — or null. */
export function checkTree(raw: unknown): { start: string; nodes: Map<string, TroubleshootingNode> } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const tree = raw as TroubleshootingTree;
  if (typeof tree.start !== "string" || !Array.isArray(tree.nodes) || tree.nodes.length === 0) return null;
  const nodes = new Map<string, TroubleshootingNode>();
  for (const node of tree.nodes) {
    if (typeof node !== "object" || node === null || typeof node.id !== "string" || !NODE_KINDS.has(node.kind) || !isL10n(node.text)) return null;
    if (node.warning !== undefined && !isL10n(node.warning)) return null;
    if (node.kind === "outcome") {
      if (!node.outcome || !OUTCOME_TYPES.has(node.outcome.type)) return null;
    } else if (!Array.isArray(node.options) || node.options.length === 0 || !node.options.every((option) => option && isL10n(option.label) && typeof option.next === "string")) {
      return null;
    }
    nodes.set(node.id, node);
  }
  if (!nodes.has(tree.start)) return null;
  for (const node of nodes.values()) for (const option of node.options ?? []) if (!nodes.has(option.next)) return null;
  return { start: tree.start, nodes };
}

/**
 * Approved trees that apply: written for this device, for its platform, or for any device (both empty). A
 * device-specific tree replaces a general one with the same symptom; malformed trees are skipped, never walked.
 */
async function applicableTrees(db: Db, device: SupportDevice | null, platformId: string | null): Promise<LoadedTree[]> {
  const rows = await db
    .select({
      id: troubleshootingTrees.id,
      symptomKey: troubleshootingTrees.symptomKey,
      title: troubleshootingTrees.title,
      tree: troubleshootingTrees.tree,
      deviceModelId: troubleshootingTrees.deviceModelId,
      platformId: troubleshootingTrees.platformId,
      isDemo: troubleshootingTrees.isDemo,
    })
    .from(troubleshootingTrees)
    .where(eq(troubleshootingTrees.status, "approved"))
    .orderBy(asc(troubleshootingTrees.symptomKey), asc(troubleshootingTrees.id));
  const usable: LoadedTree[] = [];
  for (const row of rows) {
    if (row.deviceModelId && row.deviceModelId !== device?.id) continue;
    if (!row.deviceModelId && row.platformId && row.platformId !== platformId) continue;
    const checked = checkTree(row.tree);
    if (!checked || !isL10n(row.title)) continue;
    usable.push({ id: row.id, symptomKey: row.symptomKey, title: row.title, deviceModelId: row.deviceModelId, platformId: row.platformId, isDemo: row.isDemo, ...checked });
  }
  const rank = (tree: LoadedTree) => (tree.deviceModelId ? 0 : tree.platformId ? 1 : 2);
  const bySymptom = new Map<string, LoadedTree>();
  for (const tree of usable.sort((a, b) => rank(a) - rank(b))) if (!bySymptom.has(tree.symptomKey)) bySymptom.set(tree.symptomKey, tree);
  return [...bySymptom.values()].sort((a, b) => a.symptomKey.localeCompare(b.symptomKey));
}

// ───────────────────────────────────────────────────────────────── replay

const linkTo = (state: AssistantState) => assistantSearch({ ...state, handoff: false }) || "?";

function confidenceOf(node: TroubleshootingNode): AssistantConfidence | null {
  if (node.kind === "step") return "safe_step";
  if (node.kind !== "outcome" || !node.outcome) return null;
  if (node.outcome.type === "repair") return "needs_check";
  if (node.outcome.type === "article" || node.outcome.type === "part") return "uncertain";
  return null;
}

type BotSeed = Partial<Omit<AssistantBotTurn, "id" | "role">> & Pick<AssistantBotTurn, "kind">;

class Transcript {
  readonly turns: AssistantTurn[] = [];
  user(text: string, extra: Partial<Pick<AssistantUserTurn, "i18n" | "typed" | "platform">> = {}): void {
    this.turns.push({ id: `t${this.turns.length}`, role: "user", text, i18n: extra.i18n ?? null, typed: extra.typed ?? false, ...(extra.platform ? { platform: extra.platform } : {}) });
  }
  bot(seed: BotSeed): AssistantBotTurn {
    const turn: AssistantBotTurn = { id: `t${this.turns.length}`, role: "assistant", text: "", params: {}, warning: null, warningKey: null, confidence: null, stepNumber: null, sources: [], articles: [], ...seed };
    this.turns.push(turn);
    return turn;
  }
}

/**
 * The conversation for a state: every turn replayed from the URL through approved content, the prompt to answer now,
 * the outcome once reached, the device's guides and a plain-text summary in the view's language.
 */
export async function runAssistant(db: Db, locale: Locale, state: AssistantState, options: { model?: AssistantModel | null } = {}): Promise<AssistantView> {
  const model = options.model === undefined ? configuredAssistantModel() : options.model;
  const directory = await getSupportDirectory(db, locale);
  const device = state.device && state.device !== DEVICE_OTHER ? findDevice(directory, state.device) : null;
  const deviceOther = state.device === DEVICE_OTHER;
  const group = device ? findPlatform(directory, device.platform.slug) : findPlatform(directory, state.platform);
  const platform: SupportPlatform | null = device?.platform ?? (group ? { id: group.id, slug: group.slug, name: group.name, accent: group.accent } : null);
  // What the URL asked for, cleaned: an unknown device or platform is dropped (the conversation asks again).
  const clean: AssistantState = { ...state, device: device ? device.slug : deviceOther ? DEVICE_OTHER : null, platform: device ? null : (platform?.slug ?? null) };
  const t = new Transcript();
  let isDemo = false;

  const done = (extra: Partial<AssistantView> & Pick<AssistantView, "stage">, current: AssistantState): AssistantView => {
    const view: AssistantView = {
      ai: { configured: model !== null, name: model?.name ?? null },
      device,
      deviceOther,
      platform,
      symptom: null,
      turns: t.turns,
      prompt: null,
      outcome: null,
      guides: [],
      summary: "",
      search: assistantSearch({ ...current, handoff: false }),
      isDemo,
      handoff: state.handoff,
      ...extra,
    };
    view.summary = summarizeConversation(view, serverT(locale, "support"));
    return view;
  };

  // ── device
  t.bot({ kind: "ask_device" });
  if (!device && !deviceOther) {
    if (!group) {
      const prompt: AssistantPrompt = {
        kind: "platforms",
        platforms: directory.map((entry) => ({ id: entry.id, slug: entry.slug, name: entry.name, accent: entry.accent, href: linkTo({ ...clean, platform: entry.slug, device: null }) })),
        otherHref: linkTo({ ...clean, platform: null, device: DEVICE_OTHER }),
      };
      return done({ stage: "device", prompt }, clean);
    }
    t.user(group.name, { platform: group.slug });
    t.bot({ kind: "ask_model", params: { platform: group.name, platformSlug: group.slug } });
    const prompt: AssistantPrompt = {
      kind: "models",
      platform: { id: group.id, slug: group.slug, name: group.name, accent: group.accent },
      devices: group.devices.map((entry) => ({ ...entry, href: linkTo({ ...clean, platform: null, device: entry.slug }) })),
      otherHref: linkTo({ ...clean, platform: null, device: DEVICE_OTHER }),
      backHref: linkTo({ ...clean, platform: null, device: null }),
    };
    return done({ stage: "device", prompt }, clean);
  }
  if (device) t.user(device.name);
  else t.user("", { i18n: "assistant.deviceOther" });

  // ── problem
  const [trees, guides] = await Promise.all([
    applicableTrees(db, device, platform?.id ?? null),
    device ? listArticlesForDevice(db, locale, device.id) : platform ? listArticlesForPlatform(db, locale, platform.id) : Promise.resolve([] as ArticleSummary[]),
  ]);
  if (guides.some((guide) => guide.isDemo)) isDemo = true;
  const problems = (from: AssistantState): AssistantPrompt => ({
    kind: "problems",
    symptoms: trees.map((tree): AssistantChoice => ({ label: pick(tree.title, locale), href: linkTo({ ...from, symptom: tree.symptomKey, answers: [] }) })),
    guides: guides.filter((guide) => guide.kind === "troubleshooting"),
  });
  const markDemo = (list: readonly ArticleSummary[]) => {
    if (list.some((guide) => guide.isDemo)) isDemo = true;
  };

  t.bot({ kind: "ask_problem", params: { device: device?.name ?? "" } });

  let tree = clean.symptom ? (trees.find((entry) => entry.symptomKey === clean.symptom) ?? null) : null;
  if (clean.q) {
    t.user(clean.q, { typed: true });
    const meaning = await interpret(model, locale, clean.q, device, trees);
    let matched: LoadedTree | null = null;
    if (meaning.kind === "danger") {
      t.bot({ kind: "danger", warningKey: "assistant.danger.warning" });
      return done({ stage: "done", outcome: { type: "repair", article: null, productSlug: null }, guides }, { ...clean, symptom: null, answers: [] });
    } else if (meaning.kind === "symptom") {
      matched = trees.find((entry) => entry.symptomKey === meaning.symptomKey) ?? null;
      if (matched) t.bot({ kind: "matched", params: { title: pick(matched.title, locale) }, confidence: "likely" });
      else t.bot({ kind: "unmatched" });
    } else if (meaning.kind === "code") {
      const mentioning = await findArticlesMentioning(db, locale, meaning.code);
      markDemo(mentioning);
      t.bot({ kind: mentioning.length > 0 ? "code_found" : "code", params: { code: meaning.code }, articles: mentioning, confidence: "uncertain", sources: mentioning.map((guide) => ({ type: "article" as const, id: guide.id })) });
    } else if (meaning.kind === "topic") {
      const topical = await listArticlesByTag(db, locale, meaning.topic, { deviceModelId: device?.id ?? null, platformId: platform?.id ?? null });
      markDemo(topical);
      const warningKey = meaning.topic === "battery" ? "assistant.battery.warning" : null;
      if (topical.length > 0) t.bot({ kind: "topic", params: { topic: meaning.topic }, articles: topical, confidence: "uncertain", warningKey, sources: topical.map((guide) => ({ type: "article" as const, id: guide.id })) });
      else t.bot({ kind: "unmatched", warningKey });
    } else {
      t.bot({ kind: "unmatched" });
    }
    if (!tree && matched) tree = matched; // the shopper's words chose the tree
    else if (tree && tree !== matched) t.user(pick(tree.title, locale)); // they picked a problem from the list after typing
  } else if (tree) {
    t.user(pick(tree.title, locale));
  }

  if (!tree) {
    const here: AssistantState = { ...clean, symptom: null, answers: [] };
    return done({ stage: "problem", prompt: problems(here), guides }, here);
  }

  // ── steps: replay the answers through the tree
  if (tree.isDemo) isDemo = true;
  const walked = tree;
  let node = walked.nodes.get(walked.start) as TroubleshootingNode;
  let step = 0;
  const given: number[] = [];
  const say = (current: TroubleshootingNode): AssistantBotTurn => {
    if (current.kind === "step") step++;
    return t.bot({
      kind: current.kind,
      text: pick(current.text, locale),
      warning: current.warning ? pick(current.warning, locale) : null,
      confidence: confidenceOf(current),
      stepNumber: current.kind === "step" ? step : null,
      sources: [{ type: "tree", id: walked.id, nodeId: current.id }],
    });
  };
  for (const answer of clean.answers) {
    if (node.kind === "outcome") break;
    const option = node.options?.[answer];
    if (!option) break; // an answer that does not exist ends the replay here
    say(node);
    t.user(pick(option.label, locale));
    given.push(answer);
    node = walked.nodes.get(option.next) as TroubleshootingNode;
  }
  const last = say(node);
  const now: AssistantState = { ...clean, symptom: walked.symptomKey, answers: given };
  const symptom = { key: walked.symptomKey, title: pick(walked.title, locale) };

  if (node.kind === "outcome" && node.outcome) {
    const outcome = await outcomeOf(db, locale, node.outcome, guides);
    if (outcome.article) {
      last.articles = [outcome.article];
      last.sources = [...last.sources, { type: "article", id: outcome.article.id }];
      markDemo([outcome.article]);
    }
    return done({ stage: "done", symptom, outcome, guides }, now);
  }
  const choices = (node.options ?? []).map((option, index): AssistantChoice => ({ label: pick(option.label, locale), href: linkTo({ ...now, answers: [...given, index] }) }));
  return done({ stage: "steps", symptom, prompt: { kind: "choices", choices }, guides }, now);
}

async function outcomeOf(db: Db, locale: Locale, outcome: NonNullable<TroubleshootingNode["outcome"]>, guides: readonly ArticleSummary[]): Promise<AssistantOutcome> {
  let article: ArticleSummary | null = null;
  if (outcome.type === "article" && outcome.articleSlug) {
    article = guides.find((guide) => guide.slug === outcome.articleSlug) ?? (await listHelpArticles(db, locale)).find((guide) => guide.slug === outcome.articleSlug) ?? null;
  }
  return { type: outcome.type, article, productSlug: outcome.type === "part" ? (outcome.productSlug ?? null) : null };
}

async function interpret(model: AssistantModel | null, locale: Locale, text: string, device: SupportDevice | null, trees: readonly LoadedTree[]): Promise<Interpretation> {
  const symptoms = trees.map((tree) => tree.symptomKey);
  const guided = interpretText(text, { symptoms });
  // Danger signs and error codes are never left to a model.
  if (guided.kind === "danger" || guided.kind === "code" || !model) return guided;
  const answer = await model.interpret({ text, locale, device: device?.slug ?? null, allowed: { symptoms, topics: KNOWN_TOPICS } }).catch(() => null);
  if (answer?.symptomKey && symptoms.includes(answer.symptomKey)) return { kind: "symptom", symptomKey: answer.symptomKey };
  if (answer?.topic && KNOWN_TOPICS.includes(answer.topic)) return { kind: "topic", topic: answer.topic };
  return guided;
}

// ───────────────────────────────────────────────────────────────── handoff to staff

export const HandoffInput = z.object({
  idempotencyKey: z.string().refine(isIdempotencyKey, "invalid"),
  phone: z.string().trim().min(1, "required").max(40, "phone_invalid"),
  contactName: optionalText(80),
  note: optionalText(2000, true),
  /** "Share this conversation and my number with TamTam staff" — without it nothing may be stored. */
  consent: z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.literal(true, "required")),
});
export type HandoffInput = z.input<typeof HandoffInput>;

const CONFIDENCE_LEVEL: Record<AssistantConfidence, "low" | "medium"> = { safe_step: "low", uncertain: "low", needs_check: "low", likely: "medium" };

/** The transcript as stored rows: what the shopper saw, in their language (the page's own turns rendered with its words). */
function transcriptRows(view: AssistantView, t: TFunction, sessionId: string, now: number): NewAssistantMessage[] {
  return view.turns.map((turn, index): NewAssistantMessage => {
    if (turn.role === "user") return { id: newId("amg"), sessionId, role: "user", content: turn.i18n ? t(turn.i18n) : turn.text, createdAt: now + index };
    const text = turn.text || t(`assistant.turn.${turn.kind}`, turn.params);
    const warning = turn.warning ?? (turn.warningKey ? t(turn.warningKey) : null);
    const flags = [warning ? "safety_warning" : null, turn.kind === "danger" ? "danger_stop" : null, turn.kind === "outcome" && view.outcome?.type === "repair" ? "escalation_suggested" : null].filter((flag): flag is string => flag !== null);
    return {
      id: newId("amg"),
      sessionId,
      role: "assistant",
      content: warning ? `${warning}\n${text}` : text,
      sources: turn.sources.length > 0 ? turn.sources : null,
      confidence: turn.confidence ? CONFIDENCE_LEVEL[turn.confidence] : null,
      safetyFlags: flags.length > 0 ? flags : null,
      createdAt: now + index,
    };
  });
}

/** How long a handed-over conversation is kept (assistant_sessions.expires_at). */
export const ASSISTANT_RETENTION_DAYS = 365;

/**
 * "Talk to staff": stores the conversation (with consent) and opens a support ticket whose internal note is the
 * conversation summary — built on the server from the state, never from posted text. Idempotent on the form's key,
 * rate limited per IP and phone, photos private.
 * Errors: invalid (fields: phone, contactName, note, consent, photos, idempotencyKey), rate_limited, idempotency_conflict.
 */
export async function handOffToStaff(
  db: Db,
  who: SupportWho,
  locale: Locale,
  state: AssistantState,
  raw: unknown,
  now: number,
  options: { store?: BlobStore; photos?: readonly UploadSource[] } = {},
): Promise<CreatedTicket> {
  const parsed = HandoffInput.safeParse(raw ?? {});
  const fields = parsed.success ? {} : zodFieldErrors(parsed.error);
  const phone = phoneOf((raw as { phone?: unknown } | null)?.phone);
  if (!fields.phone && "error" in phone) fields.phone = phone.error;
  if (!parsed.success || "error" in phone || Object.keys(fields).length > 0) throw invalid(fields);
  const input = parsed.data;
  const phoneE164 = phone.phoneE164;
  const sources = photoSources(options.photos ?? []);
  if (sources.length > 0 && !options.store) throw new Error("handOffToStaff: photos need a blob store");

  await enforceSupportLimits(db, "support_ticket", who.ip, phoneE164, now);

  const accessToken = await supportAccessToken("ticket", input.idempotencyKey);
  const tokenHash = await accessTokenHash(accessToken);
  const replay = await existingTicket(db, tokenHash, phoneE164, accessToken);
  if (replay) return replay;

  // The words the shopper typed are stored (the transcript, the ticket's internal note): cleaned like every other free
  // text (~/server/text.server) — the URL state only drops C0 controls (security review, second pass).
  const typed = typeof state.q === "string" ? cleanLine(state.q).replace(/\s+/g, " ").trim() || null : null;
  const stored: AssistantState = { ...state, q: typed, handoff: false };
  const shopperView = await runAssistant(db, locale, stored);
  const staffView = locale === "ar" ? shopperView : await runAssistant(db, "ar", stored);
  const staffT = serverT("ar", "support");
  const staffSummary = summarizeConversation(staffView, staffT);

  const images = await preparePhotos(sources);
  const ticket = { ...newTicketIdentity(), tokenHash };
  const actor = actorOf(who);
  const photos = images.length > 0 && options.store ? await storePhotos(options.store, images, { kind: "support_photo", ownerType: "support_ticket", ownerId: ticket.id, createdBy: actor, now }) : [];

  const sessionId = newId("ast");
  const problem = staffView.symptom?.title ?? staffT("handoff.noProblem");
  const deviceName = staffView.device?.name ?? (staffView.deviceOther ? staffT("assistant.deviceOther") : staffT("handoff.noDevice"));
  const subject = staffT("handoff.subject", { problem, device: deviceName }).slice(0, 140);

  try {
    const ticketStatements = await planSupportTicket(
      db,
      who,
      { idempotencyKey: input.idempotencyKey, phoneE164, contactName: input.contactName, subject, message: input.note, category: shopperView.device || shopperView.deviceOther ? "repair" : "other", locale },
      ticket,
      now,
      {
        channel: "assistant",
        assistantSessionId: sessionId,
        internalNote: staffSummary,
        photos,
        tags: ["assistant", ...(shopperView.symptom ? [shopperView.symptom.key] : []), ...(shopperView.device ? [shopperView.device.slug] : [])],
      },
    );
    const statements: BatchStatement[] = [
      ticketGuard(db, tokenHash),
      ...fileRowStatements(db, photos),
      db.insert(assistantSessions).values({
        id: sessionId,
        kind: "maintenance",
        customerId: who.customerId,
        sessionHash: null,
        deviceModelId: shopperView.device?.id ?? null,
        symptomKey: shopperView.symptom?.key ?? null,
        status: "escalated",
        summary: staffSummary,
        logConsent: true,
        locale,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + ASSISTANT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
      }),
      ...chunkRows(assistantMessages, transcriptRows(shopperView, serverT(locale, "support"), sessionId, now)).map((rows) => db.insert(assistantMessages).values(rows)),
      db.insert(consents).values({ id: newId("cns"), subjectType: "assistant_session", subjectId: sessionId, kind: "support_log", granted: true, source: "assistant", at: now, ip: who.ip }),
      ...ticketStatements,
    ];
    await runBatch(db, statements);
  } catch (error) {
    if (options.store) await discardPhotos(options.store, photos);
    if (isDbError(error, "SUPPORT_TICKET_EXISTS")) {
      const existing = await existingTicket(db, tokenHash, phoneE164, accessToken);
      if (existing) return existing;
    }
    throw error;
  }
  return { ticketId: ticket.id, ref: ticket.ref, accessToken, replayed: false };
}
