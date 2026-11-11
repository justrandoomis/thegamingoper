/**
 * The demo ribbon — a flat ink strip (never red, never glass) at the very top of every page while STORE_MODE is
 * "demo": "الموقع قيد الإنشاء — الأسعار والمخزون بيانات تجريبية". It scrolls away; the footer repeats it in full.
 * (The offline banner is the overlay kit's <OfflineBanner> from ~/ui/OfflineBanner, mounted by <ShellFrame>.)
 */
import { Icon } from "~/art/Icon";
import { useShellT } from "./i18n";

export function DemoRibbon() {
  const t = useShellT();
  return (
    <p className="shell-ribbon" role="note">
      <Icon name="info" size={16} />
      <span>{t("demo.ribbon")}</span>
    </p>
  );
}
