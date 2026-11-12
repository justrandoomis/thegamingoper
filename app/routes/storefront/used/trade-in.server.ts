/**
 * The trade-in wizard's page flow (server only) — which step to show, with what, and the links between steps. The
 * domain rules (devices, questionnaire, estimate, creation) are in ~/server/services/tradein.server; this file only
 * turns a URL into a step view.
 *
 * Every step is a URL, so Back, reload and a shared link all work, and the forms submit without script:
 *   /trade-in                                      device (choose a model)
 *   /trade-in?step=condition&device=…&q=…          one question per screen; answers ride along in the query
 *   /trade-in?step=photos&device=…&<answers>       private photos (cookie draft, POST /api/upload/tradein)
 *   /trade-in?step=estimate&device=…&<answers>     the indicative range (or "priced after inspection")
 *   /trade-in?step=inspection&device=…&<answers>   contact and preferred time → POST creates the request
 * A step that needs answers it does not have redirects to the first missing question. Contact details never go into
 * the URL (they are POSTed).
 */
import { redirect } from "react-router";

import { randomToken } from "~/lib/ids";
import { localePath, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import {
  answerPairs,
  estimateTradeIn,
  firstUnanswered,
  getTradeInDevice,
  inspectionDays,
  isAnswered,
  listTradeInDevices,
  listTradeInDraftPhotos,
  questionsFor,
  readTradeInAnswers,
  SINGLE_CHOICE,
  TRADE_IN_PHOTO_LIMIT,
  TRADE_IN_QUESTIONS,
  type TradeInAnswers,
  type TradeInDevice,
  type TradeInEstimate,
  type TradeInQuestion,
} from "~/server/services/tradein.server";
import { MAX_IMAGE_BYTES } from "~/server/uploads.server";
import { TRADE_IN_PATH, WIZARD_STEPS, type DeviceGroup, type WizardStep } from "./wizard";

export { TRADE_IN_PATH, WIZARD_STEPS, type WizardStep };

/** A wizard link (locale-less) — the step, the device and the answers, plus anything extra. */
export function wizardHref(step: WizardStep, device?: string | null, answers?: TradeInAnswers, extra: [string, string][] = []): string {
  const params = new URLSearchParams();
  if (step !== "device") params.set("step", step);
  if (device) params.set("device", device);
  if (answers) for (const [name, value] of answerPairs(answers)) params.append(name, value);
  for (const [name, value] of extra) params.append(name, value);
  const search = params.toString();
  return search ? `${TRADE_IN_PATH}?${search}` : TRADE_IN_PATH;
}

export type { DeviceGroup };
export type DraftPhotoView = { id: string; name: string | null; previewUrl: string };

/** What every step after the device carries for the summary (the aside from 1280, the estimate's description list). */
type Answered = {
  device: TradeInDevice;
  answers: TradeInAnswers;
  /** The questions this device gets, in order. */
  questions: TradeInQuestion[];
  /** Per answered question: the link that edits it (and, on the estimate step, comes back there). */
  edit: Partial<Record<TradeInQuestion, string>>;
};

export type WizardView =
  | {
      step: "device";
      /** Every device the store buys, by platform — the search field narrows them (on the server without script). */
      groups: DeviceGroup[];
      current: string | null;
      unknown: boolean;
      /** The search text (`?q=`), trimmed. */
      query: string;
    }
  | (Answered & {
      step: "condition";
      question: TradeInQuestion;
      /** 1-based position of this question among the device's questions. */
      index: number;
      total: number;
      /** The options of a single-choice question; the accessories for "included". */
      options: string[];
      /** Everything the form must carry besides the question itself. */
      hidden: [string, string][];
      back: string;
      /** The form was sent without an answer. */
      missing: boolean;
    })
  | (Answered & { step: "photos"; photos: DraftPhotoView[]; limit: number; maxBytes: number; next: string; back: string })
  | (Answered & {
      step: "estimate";
      estimate: TradeInEstimate;
      next: string | null;
      back: string;
    })
  | (Answered & {
      step: "inspection";
      estimate: TradeInEstimate;
      /** One per attempt: a double submission of this form makes one request. */
      idempotencyKey: string;
      /** Baghdad days the shopper may prefer, today first. */
      days: string[];
      hidden: [string, string][];
      photoCount: number;
      back: string;
    });


export type Wizard = { view: WizardView; stepIndex: number; rail: (string | null)[] };

const isStep = (value: unknown): value is WizardStep => typeof value === "string" && (WIZARD_STEPS as readonly string[]).includes(value);
const isQuestion = (value: unknown): value is TradeInQuestion => typeof value === "string" && (TRADE_IN_QUESTIONS as readonly string[]).includes(value);

/** The pairs of `answers` without one question's own pairs (the form of that question supplies them). */
function pairsWithout(answers: TradeInAnswers, question: TradeInQuestion): [string, string][] {
  const own = question === "included" ? new Set(["inc", "included"]) : new Set<string>([question]);
  return answerPairs(answers).filter(([name]) => !own.has(name));
}

function railFor(stepIndex: number, device: TradeInDevice | null, answers: TradeInAnswers): (string | null)[] {
  const first = device ? questionsFor(device)[0] : null;
  return WIZARD_STEPS.map((step, index) => {
    if (index >= stepIndex || (index > 0 && !device)) return null;
    if (step === "device") return wizardHref("device", device?.slug);
    if (step === "condition") return wizardHref("condition", device?.slug, answers, first ? [["q", first]] : []);
    return wizardHref(step, device?.slug, answers);
  });
}

/**
 * The view for a wizard URL. Throws a redirect (localized) when a step lacks what it needs: missing answers → the
 * first missing question; the last question answered → photos (or back to the estimate when editing from there).
 */
export async function loadWizard(db: Db, locale: Locale, url: URL, draftToken: string | null, now: number): Promise<Wizard> {
  const params = url.searchParams;
  const asked = params.get("step");
  const step: WizardStep = isStep(asked) ? asked : "device";
  const slug = params.get("device");
  const device = slug ? await getTradeInDevice(db, locale, slug) : null;
  const go = (href: string): never => {
    throw redirect(localePath(href, locale));
  };

  if (step === "device" || !device) {
    const devices = await listTradeInDevices(db, locale);
    const groups: DeviceGroup[] = [];
    for (const entry of devices) {
      const group = groups.find((candidate) => candidate.platformSlug === entry.platformSlug);
      if (group) group.devices.push(entry);
      else groups.push({ platformSlug: entry.platformSlug, platformName: entry.platformName, devices: [entry] });
    }
    const query = (params.get("q") ?? "").trim().slice(0, 60);
    return {
      view: { step: "device", groups, current: device?.slug ?? null, unknown: slug !== null && device === null, query },
      stepIndex: 0,
      rail: railFor(0, null, {}),
    };
  }

  const answers = readTradeInAnswers(params, device);
  const questions = questionsFor(device);
  const missing = firstUnanswered(device, answers);
  /** Edit links for the answered questions; from a later step they come back to it (`ret`). */
  const editLinks = (back: ReturnStep | null): Partial<Record<TradeInQuestion, string>> => {
    const edit: Partial<Record<TradeInQuestion, string>> = {};
    for (const question of questions) if (isAnswered(answers, question)) edit[question] = wizardHref("condition", device.slug, answers, [["q", question], ...(back ? ([["ret", back]] as [string, string][]) : [])]);
    return edit;
  };
  const answered = (back: ReturnStep | null) => ({ device, answers, questions, edit: editLinks(back) });

  if (step === "condition") {
    const q = params.get("q");
    const at = params.get("at");
    const asked = params.get("ret");
    const back: ReturnStep | null = isReturnStep(asked) ? asked : null;
    let question: TradeInQuestion;
    let unanswered = false;
    if (isQuestion(q) && questions.includes(q)) {
      question = q;
    } else if (isQuestion(at) && questions.includes(at)) {
      if (!isAnswered(answers, at)) {
        question = at;
        unanswered = true;
      } else {
        const next = questions[questions.indexOf(at) + 1];
        // An edit from a later step goes back there once nothing is missing.
        if (back && missing === null) return go(wizardHref(back, device.slug, answers));
        if (next) question = next;
        else if (missing !== null) question = missing;
        else return go(wizardHref("photos", device.slug, answers));
      }
    } else {
      question = missing ?? questions[0];
    }
    const index = questions.indexOf(question);
    const ret: [string, string][] = back ? [["ret", back]] : [];
    const hidden: [string, string][] = [["step", "condition"], ["device", device.slug], ...pairsWithout(answers, question), ["at", question], ...ret];
    const previous = questions[index - 1];
    return {
      view: {
        step: "condition",
        ...answered(null),
        question,
        index: index + 1,
        total: questions.length,
        options: question === "included" ? device.accessories : [...SINGLE_CHOICE[question]],
        hidden,
        // Back from an edit returns to the step it came from; otherwise to the previous question, then the device.
        back: back && missing === null ? wizardHref(back, device.slug, answers) : previous ? wizardHref("condition", device.slug, answers, [["q", previous], ...ret]) : wizardHref("device", device.slug),
        missing: unanswered,
      },
      stepIndex: 1,
      rail: railFor(1, device, answers),
    };
  }

  // Every later step needs the whole questionnaire.
  if (missing !== null) return go(wizardHref("condition", device.slug, answers, [["q", missing]]));
  const lastQuestion = questions[questions.length - 1];

  if (step === "photos") {
    const photos = await listTradeInDraftPhotos(db, draftToken);
    return {
      view: {
        step: "photos",
        ...answered("photos"),
        photos: photos.map((photo) => ({ id: photo.id, name: photo.name, previewUrl: `/api/upload/tradein?file=${encodeURIComponent(photo.id)}` })),
        limit: TRADE_IN_PHOTO_LIMIT,
        maxBytes: MAX_IMAGE_BYTES,
        next: wizardHref("estimate", device.slug, answers),
        back: wizardHref("condition", device.slug, answers, [["q", lastQuestion]]),
      },
      stepIndex: 2,
      rail: railFor(2, device, answers),
    };
  }

  const result = await estimateTradeIn(db, locale, device.slug, answers, now);
  if (!result) return go(wizardHref("device"));
  const { estimate } = result;

  if (step === "estimate") {
    return {
      view: {
        step: "estimate",
        ...answered("estimate"),
        estimate,
        next: estimate.kind === "refused" ? null : wizardHref("inspection", device.slug, answers),
        back: wizardHref("photos", device.slug, answers),
      },
      stepIndex: 3,
      rail: railFor(3, device, answers),
    };
  }

  // step === "inspection"
  if (estimate.kind === "refused") return go(wizardHref("estimate", device.slug, answers));
  const photos = await listTradeInDraftPhotos(db, draftToken);
  return {
    view: {
      step: "inspection",
      ...answered("inspection"),
      estimate,
      idempotencyKey: randomToken(24),
      days: inspectionDays(now, 6),
      hidden: [["device", device.slug], ...answerPairs(answers)],
      photoCount: photos.length,
      back: wizardHref("estimate", device.slug, answers),
    },
    stepIndex: 4,
    rail: railFor(4, device, answers),
  };
}

/** The steps an answer edit can return to (`ret`). */
type ReturnStep = "photos" | "estimate" | "inspection";
const isReturnStep = (value: unknown): value is ReturnStep => value === "photos" || value === "estimate" || value === "inspection";

