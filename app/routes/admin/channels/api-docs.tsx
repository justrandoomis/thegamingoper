import { Link } from "react-router";

import type { Route } from "./+types/api-docs";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { API_ENDPOINTS, API_IP_RATE, API_PAGE_DEFAULT, API_PAGE_MAX, API_RATE_DEFAULT, API_RATE_MAX, WEBHOOK_BACKOFF_MINUTES, WEBHOOK_EVENTS, WEBHOOK_MAX_ATTEMPTS } from "~/server/services/admin/channels/types";
import { Code, Note, PageHead, Section, useChT } from "./components/ui";
import { ch } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/api/docs — 21.03: the reference of the read-only API and of the webhooks, for whoever connects
 * another system (any permission of the module). One list (types.ts API_ENDPOINTS, WEBHOOK_EVENTS) feeds both this page
 * and the code, so the reference cannot drift from what answers.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args);
  return { origin: req.ctx.origin, keys: can(req.actor, "channels.api_key.manage"), webhooks: can(req.actor, "channels.webhook.manage") };
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "apiDocs.title");

const EXAMPLES: Record<string, string> = {
  products: `{
  "data": [
    {
      "sku": "PS5-SLIM-DISC",
      "variantId": "var_…",
      "productId": "prd_…",
      "slug": "playstation-5-slim",
      "kind": "console",
      "name": { "ar": "…", "en": "PlayStation 5 Slim" },
      "variantTitle": { "ar": "…", "en": "Disc" },
      "priceIqd": 899000,
      "currency": "IQD",
      "stockState": "in_stock",
      "demo": false
    }
  ],
  "next": "var_…"
}`,
  stock: `{
  "data": [{ "sku": "PS5-SLIM-DISC", "variantId": "var_…", "available": 4, "stockState": "low_stock", "demo": false }],
  "next": null
}`,
  orders: `{
  "data": [
    {
      "ref": "TT-7K4M2Q9X", "channel": "web", "status": "shipped", "paymentStatus": "cod_due", "currency": "IQD",
      "subtotalIqd": 120000, "discountIqd": 0, "shippingIqd": 5000, "taxIqd": 0, "totalIqd": 125000, "paidIqd": 0, "refundedIqd": 0,
      "placedAt": 1731300000000, "updatedAt": 1731400000000, "demo": false,
      "lines": [{ "sku": "PS5-DS-WHITE", "qty": 1, "unitPriceIqd": 120000, "discountIqd": 0, "totalIqd": 120000 }]
    }
  ],
  "next": "1731400000000.ord_…"
}`,
};

const PING = `POST https://receiver.example.com/tamtam
Content-Type: application/json; charset=utf-8
X-TamTam-Event: order.shipped
X-TamTam-Event-Id: oev_…
X-TamTam-Delivery: whd_…
X-TamTam-Signature: t=1731400000,v1=5f0c…

{ "id": "oev_…", "event": "order.shipped", "occurredAt": 1731400000000, "demo": false,
  "data": { "order": { "ref": "TT-7K4M2Q9X", "channel": "web", "status": "shipped", "totalIqd": 125000, "currency": "IQD" } },
  "deliveryId": "whd_…" }`;

const VERIFY = `// Node, receiving a delivery
import { createHmac, timingSafeEqual } from "node:crypto";
const header = req.headers["x-tamtam-signature"];              // "t=<seconds>,v1=<hex>"
const { t, v1 } = Object.fromEntries(header.split(",").map((part) => part.split("=")));
const expected = createHmac("sha256", process.env.TAMTAM_WEBHOOK_SECRET).update(\`\${t}.\${rawBody}\`).digest("hex");
const fresh = Math.abs(Date.now() / 1000 - Number(t)) <= 300;
const valid = fresh && timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
// then: drop the delivery if "X-TamTam-Delivery" (or the event id) was handled before — a retry repeats it`;

export default function ApiDocsPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { origin, keys, webhooks } = loaderData;
  return (
    <>
      <PageHead
        title={t("apiDocs.title")}
        lead={t("apiDocs.lead")}
        actions={
          keys ? (
            <Link to="/admin/channels/api" className="adm-link type-label">
              {t("apiDocs.manageKeys")}
            </Link>
          ) : null
        }
      />
      <Note tone="warn" icon="warning">
        <p>{t("apiKeys.routeNote")}</p>
      </Note>

      <Section id="ch-docs-auth" title={t("apiDocs.auth")}>
        <ol className="ch-steps type-body">
          <li>{t("apiDocs.authStep1")}</li>
          <li>{t("apiDocs.authStep2")}</li>
          <li>{t("apiDocs.authStep3")}</li>
        </ol>
        <pre dir="ltr" className="ch-pre">{`curl -H "Authorization: Bearer ttk_XXXXXXXX_…" "${origin}/api/v1/products?limit=${API_PAGE_DEFAULT}"`}</pre>
        <ul role="list" className="ch-list type-body">
          <li>
            <span>{t("apiDocs.ruleRead")}</span>
          </li>
          <li>
            <span>{t("apiDocs.rulePaging", { def: f.number(API_PAGE_DEFAULT), max: f.number(API_PAGE_MAX) })}</span>
          </li>
          <li>
            <span>{t("apiDocs.ruleRate", { def: f.number(API_RATE_DEFAULT), max: f.number(API_RATE_MAX), ip: f.number(API_IP_RATE) })}</span>
          </li>
          <li>
            <span>{t("apiDocs.ruleNoCost")}</span>
          </li>
          <li>
            <span>{t("apiDocs.ruleAudit")}</span>
          </li>
        </ul>
      </Section>

      <Section id="ch-docs-endpoints" title={t("apiDocs.endpoints")}>
        <div className="grid gap-4">
          {API_ENDPOINTS.map((endpoint) => (
            <article key={endpoint.path} className="adm-card gap-2">
              <h3 className="adm-h3">
                <Code>{`GET ${endpoint.path}`}</Code>
              </h3>
              <p className="type-body text-ink">{t(`apiDocs.endpoint.${endpoint.resource}`)}</p>
              <p className="type-caption text-ink-2">
                {t("apiDocs.scope")} <Code>{endpoint.scope}</Code> · {t("apiDocs.params")} <Code>{endpoint.params.join(", ")}</Code>
              </p>
              <pre dir="ltr" className="ch-pre">
                {EXAMPLES[endpoint.resource]}
              </pre>
            </article>
          ))}
        </div>
      </Section>

      <Section id="ch-docs-errors" title={t("apiDocs.errors")}>
        <dl className="ch-facts type-data">
          {["400", "401", "403", "404", "405", "429"].map((status) => (
            <div key={status} className="contents">
              <dt>
                <Code>{status}</Code>
              </dt>
              <dd>{t(`apiDocs.status.${status}`)}</dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section id="ch-docs-webhooks" title={t("apiDocs.webhooks")}>
        <p className="type-body text-ink">{t("apiDocs.webhooksLead")}</p>
        <div className="ch-scopes type-caption text-ink-2">
          <span>{t("apiDocs.events")}</span>
          {[...WEBHOOK_EVENTS, "ping"].map((event) => (
            <bdi key={event} dir="ltr" className="whitespace-nowrap text-ink">
              {event}
            </bdi>
          ))}
        </div>
        <pre dir="ltr" className="ch-pre">
          {PING}
        </pre>
        <p className="type-body text-ink">{t("apiDocs.retries", { attempts: f.number(WEBHOOK_MAX_ATTEMPTS), waits: WEBHOOK_BACKOFF_MINUTES.map((minutes) => f.number(minutes)).join(t("common.listSep")) })}</p>
        <pre dir="ltr" className="ch-pre">
          {VERIFY}
        </pre>
        <Note tone="warn" icon="warning">
          <p>{t("apiDocs.boundary")}</p>
        </Note>
        {webhooks ? (
          <Link to="/admin/channels/webhooks" className="adm-link type-label">
            {t("apiDocs.manageWebhooks")}
          </Link>
        ) : null}
      </Section>
    </>
  );
}
