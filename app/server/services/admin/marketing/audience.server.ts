/**
 * Admin 16.01 / 16.03 — who a campaign may reach, decided from the records and never assumed.
 *
 *   const result = await resolveAudience(db, { spec, channel: "sms", isDemo: false, now });
 *   result.recipients      // people with an explicit, current marketing consent, reachable on the channel, under the limits
 *   result.excluded        // how many were left out, by the first reason that applies (EXCLUSION_REASONS)
 *
 * THE RULES (asked by module 07's review, docs/areas/admin-customers.md):
 *   · A PERSON is an account (`customers`) with every guest checkout of its number or claimed by it, or — without an
 *     account — a phone number with its guest checkouts. A guest number that belongs to an account is that account.
 *   · CONSENT is the person's newest `consents` answer of kind "marketing" across all of those subjects (the account
 *     and each guest contact): granted = may be messaged; a later "no" anywhere wins; no answer = never asked = no.
 *     Guest-checkout answers per number count (they are the person's own ticked box at checkout).
 *   · Merged, deleted (erased) or anonymized accounts never receive anything, nor does a number tied to one; blocked
 *     accounts neither. Demo people only in demo campaigns, real people only in real ones.
 *   · An account that switched the channel off in its notification settings is left out on that channel; e-mail needs
 *     an address (guests have none).
 *   · SEND_LIMITS: at most `maxPerWindow` marketing messages (campaigns + cart reminders) per recipient per
 *     `windowDays` — counted from the outbox.
 *   · The same checks run again INSIDE the write (`recipientGuard`), so a withdrawal that lands between the count and
 *     the release still keeps the message out.
 *
 * Audiences are module 07's stored segments (`customer_segments`, recomputed by its job) and/or what people bought:
 * platform (`products.platform_id` of the lines) and purchase dates (`orders.placed_at`, Baghdad days) of accepted
 * orders (BOUGHT_STATUSES). No consent → the audience is everyone who ever said yes (then checked as above).
 */
import { sql, type SQL } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { phoneView } from "~/server/services/admin/customers/shared.server";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { assertAny, num, SECTION_READ } from "./shared.server";
import {
  BOUGHT_STATUSES,
  DAY_MS,
  MARKETING_TEMPLATES,
  MAX_AUDIENCE,
  SEND_LIMITS,
  dayStart,
  emptyExclusions,
  firstName,
  type AudiencePreview,
  type AudienceQuery,
  type AudienceSpec,
  type ExclusionReason,
  type MessageChannel,
  type MessageLocale,
  type RecipientSample,
} from "./types";

// ───────────────────────────────────────────────────────────────── people

export type Person = {
  key: string;
  customerId: string | null;
  phone: string | null;
  email: string | null;
  name: string | null;
  locale: MessageLocale;
  guestIds: string[];
  /** Account status ("active", "blocked", "merged", "deleted"); null for a number without an account. */
  status: string | null;
  anonymized: boolean;
  isDemo: boolean;
  prefs: Record<string, unknown> | null;
  consent: { granted: boolean; at: number; source: string | null } | null;
};

export type Recipient = { person: Person; recipient: string; firstName: string | null };

export type AudienceResolution = {
  candidates: number;
  recipients: Recipient[];
  /** Left out for want of consent, with the address they would have had (documented as skipped_no_consent). */
  noConsent: Recipient[];
  excluded: Record<ExclusionReason, number>;
  truncated: boolean;
};

type CandidateRow = { customer_id: string | null; guest_contact_id: string | null; phone: string | null; locale: string | null };
type GuestRow = { id: string; phone_e164: string; customer_id: string | null; name: string | null };
type AccountRow = { id: string; phone_e164: string; email: string | null; name: string | null; locale: string | null; status: string; anonymized_at: number | null; is_demo: number; notification_prefs: string | null };
type ConsentRow = { subject_type: string; subject_id: string; granted: number; at: number; id: string; source: string | null };

const LOCALES: readonly MessageLocale[] = ["ar", "en", "ckb"];
const localeOf = (value: string | null | undefined): MessageLocale => (value && (LOCALES as readonly string[]).includes(value) ? (value as MessageLocale) : "ar");
const isRealPhone = (phone: string | null | undefined): phone is string => typeof phone === "string" && /^\+9647\d{9}$/.test(phone);
const CHUNK = 900;

async function inChunks<T>(values: readonly string[], run: (list: string) => Promise<T[]>): Promise<T[]> {
  const unique = [...new Set(values.filter((value) => typeof value === "string" && value.length > 0))];
  const out: T[] = [];
  for (let i = 0; i < unique.length; i += CHUNK) out.push(...(await run(JSON.stringify(unique.slice(i, i + CHUNK)))));
  return out;
}
const list = (json: string) => sql`(SELECT value FROM json_each(${json}))`;

function parsePrefs(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The candidate rows of an audience: from what they bought, module 07's segment, or everyone who ever said yes. */
async function candidateRows(db: Db, spec: AudienceSpec, isDemo: boolean): Promise<{ rows: CandidateRow[]; segmentMembers: Set<string> | null; bySegmentOnly: boolean; truncated: boolean }> {
  const byOrders = spec.platformIds.length > 0 || spec.boughtFrom !== null || spec.boughtTo !== null;
  const segmentMembers = spec.segmentId
    ? new Set((await db.all<{ customer_id: string }>(sql`SELECT customer_id FROM customer_segment_members WHERE segment_id = ${spec.segmentId}`)).map((row) => row.customer_id))
    : null;
  const cap = MAX_AUDIENCE * 3;
  if (byOrders) {
    const from = dayStart(spec.boughtFrom);
    const toStart = dayStart(spec.boughtTo);
    const to = toStart === null ? null : toStart + DAY_MS;
    const statuses = JSON.stringify(BOUGHT_STATUSES);
    const platforms = JSON.stringify(spec.platformIds);
    const rows = await db.all<CandidateRow>(sql`
      SELECT o.customer_id, o.guest_contact_id, o.contact_phone_e164 AS phone, o.locale
      FROM orders o
      WHERE o.is_demo = ${isDemo ? 1 : 0}
        AND o.status IN (SELECT value FROM json_each(${statuses}))
        AND (${from} IS NULL OR o.placed_at >= ${from})
        AND (${to} IS NULL OR o.placed_at < ${to})
        AND (${spec.platformIds.length} = 0 OR EXISTS (
          SELECT 1 FROM order_items oi JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
          WHERE oi.order_id = o.id AND p.platform_id IN (SELECT value FROM json_each(${platforms}))))
        AND (o.customer_id IS NOT NULL OR ${spec.guests ? 1 : 0} = 1)
        AND (o.customer_id IS NOT NULL OR o.guest_contact_id IS NOT NULL OR o.contact_phone_e164 IS NOT NULL)
      GROUP BY o.customer_id, o.guest_contact_id, o.contact_phone_e164
      ORDER BY MAX(o.placed_at) DESC
      LIMIT ${cap + 1}`);
    return { rows: rows.slice(0, cap), segmentMembers, bySegmentOnly: false, truncated: rows.length > cap };
  }
  if (segmentMembers) {
    const rows = [...segmentMembers].map((id) => ({ customer_id: id, guest_contact_id: null, phone: null, locale: null }));
    return { rows: rows.slice(0, cap), segmentMembers, bySegmentOnly: true, truncated: rows.length > cap };
  }
  // everyone who ever said yes (each answer is checked again below: a later "no" wins)
  const subjects = await db.all<{ subject_type: string; subject_id: string }>(sql`
    SELECT DISTINCT subject_type, subject_id FROM consents
    WHERE kind = 'marketing' AND granted = 1 AND subject_type IN ('customer', 'guest_contact')
    LIMIT ${cap + 1}`);
  const rows: CandidateRow[] = [];
  for (const subject of subjects.slice(0, cap)) {
    if (subject.subject_type === "customer") rows.push({ customer_id: subject.subject_id, guest_contact_id: null, phone: null, locale: null });
    else if (spec.guests) rows.push({ customer_id: null, guest_contact_id: subject.subject_id, phone: null, locale: null });
  }
  return { rows, segmentMembers: null, bySegmentOnly: false, truncated: subjects.length > cap };
}

/**
 * Folds candidate rows into people (an account with its number's guest checkouts, or a number) and loads what the
 * rules need: account state, demo flag, channel settings, the newest marketing answer.
 */
export async function loadPeople(db: Db, rows: readonly CandidateRow[], options: { demoFromOrders: boolean | null }): Promise<Person[]> {
  const guestIds = rows.map((row) => row.guest_contact_id).filter((id): id is string => Boolean(id));
  const candidatePhones = rows.filter((row) => !row.customer_id).map((row) => row.phone).filter(isRealPhone);
  const guestsA = await inChunks(guestIds, (json) => db.all<GuestRow>(sql`SELECT id, phone_e164, customer_id, name FROM guest_contacts WHERE id IN ${list(json)}`));
  const guestById = new Map(guestsA.map((row) => [row.id, row]));
  const phones = [...new Set([...candidatePhones, ...guestsA.map((row) => row.phone_e164).filter(isRealPhone)])];
  const accountIds = [...new Set([...rows.map((row) => row.customer_id).filter((id): id is string => Boolean(id)), ...guestsA.map((row) => row.customer_id).filter((id): id is string => Boolean(id))])];
  const accountsById = await inChunks(accountIds, (json) =>
    db.all<AccountRow>(sql`SELECT id, phone_e164, email, name, locale, status, anonymized_at, is_demo, notification_prefs FROM customers WHERE id IN ${list(json)}`),
  );
  const accountsByPhone = await inChunks(phones, (json) =>
    db.all<AccountRow>(sql`SELECT id, phone_e164, email, name, locale, status, anonymized_at, is_demo, notification_prefs FROM customers WHERE phone_e164 IN ${list(json)}`),
  );
  const account = new Map<string, AccountRow>();
  for (const row of [...accountsById, ...accountsByPhone]) account.set(row.id, row);
  const accountOfPhone = new Map<string, string>();
  for (const row of account.values()) if (isRealPhone(row.phone_e164)) accountOfPhone.set(row.phone_e164, row.id);

  // every guest checkout of these accounts and numbers
  const accountPhones = [...account.values()].map((row) => row.phone_e164).filter(isRealPhone);
  const linked = await inChunks([...account.keys()], (json) => db.all<GuestRow>(sql`SELECT id, phone_e164, customer_id, name FROM guest_contacts WHERE customer_id IN ${list(json)}`));
  const byPhone = await inChunks([...new Set([...accountPhones, ...phones])], (json) => db.all<GuestRow>(sql`SELECT id, phone_e164, customer_id, name FROM guest_contacts WHERE phone_e164 IN ${list(json)}`));
  for (const row of [...linked, ...byPhone]) guestById.set(row.id, row);

  const people = new Map<string, Person>();
  const accountPerson = (id: string): Person | null => {
    const key = `c:${id}`;
    const existing = people.get(key);
    if (existing) return existing;
    const row = account.get(id);
    if (!row) return null;
    const person: Person = {
      key,
      customerId: id,
      phone: isRealPhone(row.phone_e164) ? row.phone_e164 : null,
      email: row.email?.trim().toLowerCase() || null,
      name: row.name,
      locale: localeOf(row.locale),
      guestIds: [],
      status: row.status,
      anonymized: row.anonymized_at !== null,
      isDemo: num(row.is_demo) === 1,
      prefs: parsePrefs(row.notification_prefs),
      consent: null,
    };
    people.set(key, person);
    return person;
  };
  const numberPerson = (phone: string, row: CandidateRow | null, name: string | null): Person => {
    const key = `p:${phone}`;
    const existing = people.get(key);
    if (existing) return existing;
    const person: Person = {
      key,
      customerId: null,
      phone,
      email: null,
      name,
      locale: localeOf(row?.locale),
      guestIds: [],
      status: null,
      anonymized: false,
      isDemo: options.demoFromOrders ?? false,
      prefs: null,
      consent: null,
    };
    people.set(key, person);
    return person;
  };

  for (const row of rows) {
    if (row.customer_id) {
      accountPerson(row.customer_id);
      continue;
    }
    const guest = row.guest_contact_id ? guestById.get(row.guest_contact_id) : undefined;
    if (guest?.customer_id && account.has(guest.customer_id)) {
      accountPerson(guest.customer_id);
      continue;
    }
    const phone = isRealPhone(row.phone) ? row.phone : isRealPhone(guest?.phone_e164) ? guest.phone_e164 : null;
    if (!phone) continue;
    const owner = accountOfPhone.get(phone);
    if (owner) accountPerson(owner);
    else numberPerson(phone, row, guest?.name ?? null);
  }

  // attach guest checkouts to their person
  for (const guest of guestById.values()) {
    const owner = guest.customer_id && account.has(guest.customer_id) ? `c:${guest.customer_id}` : accountOfPhone.has(guest.phone_e164) ? `c:${accountOfPhone.get(guest.phone_e164)}` : `p:${guest.phone_e164}`;
    const person = people.get(owner);
    if (person && !person.guestIds.includes(guest.id)) {
      person.guestIds.push(guest.id);
      if (!person.name && guest.name) person.name = guest.name;
    }
  }

  // a number's demo flag when it did not come from filtered orders: real as soon as one real order exists
  const numbers = [...people.values()].filter((person) => person.customerId === null);
  if (options.demoFromOrders === null && numbers.length > 0) {
    const demo = await inChunks(
      numbers.flatMap((person) => person.guestIds),
      (json) => db.all<{ guest_contact_id: string; real: number }>(sql`SELECT guest_contact_id, MAX(CASE WHEN is_demo = 0 THEN 1 ELSE 0 END) AS real FROM orders WHERE guest_contact_id IN ${list(json)} GROUP BY guest_contact_id`),
    );
    const real = new Set(demo.filter((row) => num(row.real) === 1).map((row) => row.guest_contact_id));
    const any = new Set(demo.map((row) => row.guest_contact_id));
    for (const person of numbers) person.isDemo = person.guestIds.some((id) => any.has(id)) && !person.guestIds.some((id) => real.has(id));
  }

  // the newest marketing answer across each person's subjects
  const allPeople = [...people.values()];
  const consentRows = [
    ...(await inChunks(
      allPeople.map((person) => person.customerId).filter((id): id is string => Boolean(id)),
      (json) => db.all<ConsentRow>(sql`SELECT subject_type, subject_id, granted, at, id, source FROM consents WHERE kind = 'marketing' AND subject_type = 'customer' AND subject_id IN ${list(json)}`),
    )),
    ...(await inChunks(
      allPeople.flatMap((person) => person.guestIds),
      (json) => db.all<ConsentRow>(sql`SELECT subject_type, subject_id, granted, at, id, source FROM consents WHERE kind = 'marketing' AND subject_type = 'guest_contact' AND subject_id IN ${list(json)}`),
    )),
  ].sort((a, b) => num(b.at) - num(a.at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const subjectOwner = new Map<string, Person>();
  for (const person of allPeople) {
    if (person.customerId) subjectOwner.set(`customer:${person.customerId}`, person);
    for (const id of person.guestIds) subjectOwner.set(`guest_contact:${id}`, person);
  }
  for (const row of consentRows) {
    const person = subjectOwner.get(`${row.subject_type}:${row.subject_id}`);
    if (person && !person.consent) person.consent = { granted: num(row.granted) === 1, at: num(row.at), source: row.source };
  }
  return allPeople;
}

/** The address a person has on a channel (E.164 phone or e-mail), or null. */
export function addressOn(person: Person, channel: MessageChannel): string | null {
  return channel === "email" ? person.email : person.phone;
}

/** The first rule a person breaks (EXCLUSION_REASONS order) before the address and the limits; null = none. */
export function personBlock(person: Person, channel: MessageChannel, isDemo: boolean): ExclusionReason | null {
  if (person.customerId && (person.status === "merged" || person.status === "deleted" || person.anonymized)) return "account_closed";
  if (person.customerId && person.status === "blocked") return "blocked";
  if (person.isDemo !== isDemo) return "demo_mismatch";
  if (!person.consent) return "no_consent";
  if (!person.consent.granted) return "consent_withdrawn";
  if (person.prefs && person.prefs[channel] === false) return "channel_off";
  return null;
}

/** Marketing messages each recipient was held in the window (campaign `excludeCampaignId` left out). */
export async function recentMarketing(db: Db, recipients: readonly string[], now: number, excludeCampaignId: string | null = null): Promise<Map<string, number>> {
  const since = now - SEND_LIMITS.windowDays * DAY_MS;
  const templates = JSON.stringify(MARKETING_TEMPLATES);
  const found = await inChunks(recipients, (json) =>
    db.all<{ recipient: string; n: number }>(sql`
      SELECT recipient, COUNT(*) AS n FROM outbox
      WHERE template IN (SELECT value FROM json_each(${templates})) AND created_at > ${since} AND recipient IN ${list(json)}
        AND NOT (ref_type IS 'campaign' AND ref_id IS ${excludeCampaignId})
      GROUP BY recipient`),
  );
  return new Map(found.map((row) => [row.recipient, num(row.n)]));
}

export type ResolveInput = { spec: AudienceSpec; channel: MessageChannel; isDemo: boolean; now: number; excludeCampaignId?: string | null };

/** Everyone the audience names, each checked against every rule of the file header. */
export async function resolveAudience(db: Db, input: ResolveInput): Promise<AudienceResolution> {
  const { rows, segmentMembers, bySegmentOnly, truncated } = await candidateRows(db, input.spec, input.isDemo);
  const byOrders = input.spec.platformIds.length > 0 || input.spec.boughtFrom !== null || input.spec.boughtTo !== null;
  let people = await loadPeople(db, rows, { demoFromOrders: byOrders ? input.isDemo : null });
  if (segmentMembers && !bySegmentOnly) people = people.filter((person) => person.customerId !== null && segmentMembers.has(person.customerId));
  if (!input.spec.guests) people = people.filter((person) => person.customerId !== null);

  const excluded = emptyExclusions();
  const passing: Recipient[] = [];
  const noConsent: Recipient[] = [];
  const seen = new Set<string>();
  for (const person of people) {
    const block = personBlock(person, input.channel, input.isDemo);
    const address = addressOn(person, input.channel);
    if (block) {
      excluded[block]++;
      if ((block === "no_consent" || block === "consent_withdrawn") && address && !seen.has(address)) {
        seen.add(address);
        noConsent.push({ person, recipient: address, firstName: firstName(person.name) });
      }
      continue;
    }
    if (!address) {
      excluded.no_address++;
      continue;
    }
    if (seen.has(address)) {
      excluded.duplicate++;
      continue;
    }
    seen.add(address);
    passing.push({ person, recipient: address, firstName: firstName(person.name) });
  }
  const recent = await recentMarketing(db, passing.map((entry) => entry.recipient), input.now, input.excludeCampaignId ?? null);
  const recipients: Recipient[] = [];
  for (const entry of passing) {
    if ((recent.get(entry.recipient) ?? 0) >= SEND_LIMITS.maxPerWindow) excluded.frequency_cap++;
    else recipients.push(entry);
  }
  return { candidates: people.length, recipients, noConsent, excluded, truncated };
}

// ───────────────────────────────────────────────────────────────── the write guard

/**
 * SQL that is true for a recipient spec `r.value` (json_each over the specs) when every rule still holds at write
 * time: the newest marketing answer across its subjects is a yes, its account is open, its number is not an
 * account that is closed or blocked, and the sending limit leaves room. Spec fields: customerId, guestIds, phone,
 * recipient.
 */
export function recipientGuard(now: number, excludeCampaignId: string | null): SQL {
  const since = now - SEND_LIMITS.windowDays * DAY_MS;
  const templates = JSON.stringify(MARKETING_TEMPLATES);
  return sql`COALESCE((
      SELECT c.granted FROM consents c
      WHERE c.kind = 'marketing' AND (
        (c.subject_type = 'customer' AND c.subject_id = json_extract(r.value, '$.customerId'))
        OR (c.subject_type = 'guest_contact' AND c.subject_id IN (SELECT g.value FROM json_each(json_extract(r.value, '$.guestIds')) AS g)))
      ORDER BY c.at DESC, c.id DESC LIMIT 1), 0) = 1
    AND (json_extract(r.value, '$.customerId') IS NULL OR EXISTS (
      SELECT 1 FROM customers cu WHERE cu.id = json_extract(r.value, '$.customerId') AND cu.status = 'active' AND cu.anonymized_at IS NULL))
    AND (json_extract(r.value, '$.phone') IS NULL OR NOT EXISTS (
      SELECT 1 FROM customers cx WHERE cx.phone_e164 = json_extract(r.value, '$.phone') AND (cx.status <> 'active' OR cx.anonymized_at IS NOT NULL)))
    AND (SELECT COUNT(*) FROM outbox o
      WHERE o.recipient = json_extract(r.value, '$.recipient') AND o.template IN (SELECT value FROM json_each(${templates})) AND o.created_at > ${since}
        AND NOT (o.ref_type IS 'campaign' AND o.ref_id IS ${excludeCampaignId})) < ${SEND_LIMITS.maxPerWindow}`;
}

// ───────────────────────────────────────────────────────────────── previews (16.01, 16.03)

export type SegmentOption = { id: string; name: string; members: number; computedAt: number | null };
export type PlatformOption = { id: string; slug: string; name: string };

export async function segmentOptions(db: Db, locale: Locale): Promise<SegmentOption[]> {
  const rows = await db.all<{ id: string; name: string; member_count: number; computed_at: number | null }>(sql`SELECT id, name, member_count, computed_at FROM customer_segments ORDER BY key`);
  return rows.map((row) => {
    let name: L10n = { ar: row.id };
    try {
      name = JSON.parse(row.name) as L10n;
    } catch {
      /* a broken name shows its id */
    }
    return { id: row.id, name: pick(name, locale) || row.id, members: num(row.member_count), computedAt: row.computed_at === null ? null : num(row.computed_at) };
  });
}

export async function platformOptions(db: Db, locale: Locale): Promise<PlatformOption[]> {
  const rows = await db.all<{ id: string; slug: string; name: string }>(sql`SELECT id, slug, name FROM platforms WHERE is_active = 1 ORDER BY sort, id`);
  return rows.map((row) => {
    let name: L10n = { ar: row.slug };
    try {
      name = JSON.parse(row.name) as L10n;
    } catch {
      /* keep the slug */
    }
    return { id: row.id, slug: row.slug, name: pick(name, locale) || row.slug };
  });
}

/** What a resolution looks like on a page: counts, reasons and the first people (phones masked unless allowed). */
export function previewOf(actor: Actor, result: AudienceResolution, segment: SegmentOption | null, sampleSize = 20): AudiencePreview {
  return {
    candidates: result.candidates,
    eligible: result.recipients.length,
    excluded: result.excluded,
    sample: result.recipients.slice(0, sampleSize).map((entry) => sampleOf(actor, entry)),
    truncated: result.truncated,
    segment: segment ? { id: segment.id, name: segment.name, members: segment.members, computedAt: segment.computedAt } : null,
  };
}

function sampleOf(actor: Actor, entry: Recipient): RecipientSample {
  const phoneFull = can(actor, "customer.phone.read_full");
  return {
    key: entry.person.key,
    name: entry.person.name,
    phone: phoneView(entry.person.phone, phoneFull),
    email: entry.person.email ? maskEmail(entry.person.email, phoneFull) : null,
    profileId: customerProfileId(actor, entry.person.customerId),
    guest: entry.person.customerId === null,
    consentAt: entry.person.consent?.at ?? null,
    consentSource: entry.person.consent?.source ?? null,
  };
}

/** "s•••@example.com" unless the employee may see full contact details. */
export function maskEmail(email: string, full: boolean): string {
  if (full) return email;
  const at = email.indexOf("@");
  return at <= 0 ? "•••" : `${email[0]}•••${email.slice(at)}`;
}

export type ExploreResult = {
  query: AudienceQuery;
  preview: AudiencePreview;
  /** Buyers per platform in the date window and the chosen segment (an account or a number; before consent is checked). */
  byPlatform: { platformId: string | null; name: string; buyers: number }[];
  segments: SegmentOption[];
  platforms: PlatformOption[];
};

/**
 * The segmentation explorer (16.03): who bought which platform when, and how many of them may be messaged now —
 * module 07's segment narrows it, the counts follow every rule above (SMS as the channel).
 */
export async function exploreAudience(db: Db, actor: Actor, query: AudienceQuery, locale: Locale, now: number): Promise<ExploreResult> {
  assertAny(actor, SECTION_READ.segments);
  const [segments, platforms] = await Promise.all([segmentOptions(db, locale), platformOptions(db, locale)]);
  const segment = query.segmentId ? (segments.find((entry) => entry.id === query.segmentId) ?? null) : null;
  const spec: AudienceSpec = { ...query, segmentId: segment?.id ?? null, platformIds: query.platformIds.filter((id) => platforms.some((platform) => platform.id === id)) };
  const result = await resolveAudience(db, { spec, channel: "sms", isDemo: query.demo, now });
  const from = dayStart(spec.boughtFrom);
  const toStart = dayStart(spec.boughtTo);
  const to = toStart === null ? null : toStart + DAY_MS;
  const statuses = JSON.stringify(BOUGHT_STATUSES);
  // the same people the audience is drawn from: with module 07's segment chosen, only its members (accounts)
  const rows = await db.all<{ platform_id: string | null; buyers: number }>(sql`
    SELECT p.platform_id, COUNT(DISTINCT COALESCE(o.customer_id, o.contact_phone_e164, o.guest_contact_id)) AS buyers
    FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN variants v ON v.id = oi.variant_id JOIN products p ON p.id = v.product_id
    WHERE o.is_demo = ${query.demo ? 1 : 0} AND o.status IN (SELECT value FROM json_each(${statuses}))
      AND (${from} IS NULL OR o.placed_at >= ${from}) AND (${to} IS NULL OR o.placed_at < ${to})
      AND (o.customer_id IS NOT NULL OR ${spec.guests ? 1 : 0} = 1)
      AND (${spec.segmentId} IS NULL OR o.customer_id IN (SELECT m.customer_id FROM customer_segment_members m WHERE m.segment_id = ${spec.segmentId}))
    GROUP BY p.platform_id
    ORDER BY buyers DESC`);
  const byPlatform = rows.map((row) => ({ platformId: row.platform_id, name: platforms.find((platform) => platform.id === row.platform_id)?.name ?? "", buyers: num(row.buyers) }));
  return { query: { ...query, ...spec }, preview: previewOf(actor, result, segment), byPlatform, segments, platforms };
}
