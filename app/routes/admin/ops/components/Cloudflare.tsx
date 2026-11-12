/**
 * Where the full picture lives — Cloudflare, outside the app (no APM or analytics provider is connected): the steps an
 * owner or the developer follows to see every error (Workers Logs) or every request's timing (the Worker's metrics),
 * written once for the errors and the speed pages. Honest boundary: the app links nowhere it cannot vouch for.
 */
import { Code, Section, useOpsT } from "./ui";

export function CloudflareSteps({ kind }: { kind: "errors" | "speed" }) {
  const t = useOpsT();
  const steps = kind === "errors" ? ["open", "worker", "filter", "event", "tail", "d1"] : ["open", "metrics", "query", "d1", "rum"];
  return (
    <Section id={`ops-cf-${kind}`} title={t(`cloudflare.${kind}.title`)}>
      <div className="adm-card gap-3">
        <p className="type-body text-ink">{t(`cloudflare.${kind}.lead`)}</p>
        <ol className="ops-steps type-body text-ink">
          {steps.map((step) => (
            <li key={step}>{t(`cloudflare.${kind}.${step}`)}</li>
          ))}
        </ol>
        {kind === "errors" ? (
          <p className="type-caption text-ink-2">
            {t("cloudflare.errors.command")} <Code>npx wrangler tail tamtam-games --status error --format pretty</Code>
          </p>
        ) : null}
      </div>
    </Section>
  );
}
