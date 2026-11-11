import { Link } from "react-router";

import type { RegistrySource } from "~/server/services/admin/devices/types";
import { Ref, useDevicesT } from "./ui";

/** Where a registry unit came from: the supplier and its receipt / order, the trade-in, the demo seed. */
export function SourceText({ source }: { source: RegistrySource }) {
  const t = useDevicesT();
  switch (source.kind) {
    case "receipt":
      return (
        <span className="grid">
          <span>{source.supplier ?? t("registry.supplierUnknown")}</span>
          <span className="type-caption text-ink-2">
            {source.receiptRef ? <Ref value={source.receiptRef} /> : null}
            {source.poRef ? (
              <>
                {" "}
                · <Ref value={source.poRef} />
              </>
            ) : null}
          </span>
        </span>
      );
    case "trade_in":
      return source.tradeInRef ? (
        <Link to={`/admin/devices/trade-ins/${source.tradeInRef}`} className="adm-link">
          <Ref value={source.tradeInRef} />
        </Link>
      ) : (
        <span>{t("source.trade_in")}</span>
      );
    case "opening":
      return <span>{t("registry.demoOpening")}</span>;
    default:
      return <span>{source.ref ? <Ref value={source.ref} /> : t("registry.sourceUnknown")}</span>;
  }
}
