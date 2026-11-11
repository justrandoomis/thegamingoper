/**
 * Blueprint status — what exists in the ADMIN for each of the 176 functions of the client's blueprint
 * (docs/admin-blueprint.json, typed in ./shell/blueprint-catalog.ts). CONTRACTS.md §4: owner = admin shell; every
 * module owner updates the entries of their own module, truthfully, in the same change as the code. docs/STATUS.md is
 * generated from it (`blueprintStatusMarkdown()`), and the admin shows it on every module page (<ModuleFunctions>) and
 * on /admin/blueprint.
 *
 *   implemented   staff can do it in the admin today, completely; `route` says where
 *   partial       staff can do part of it in the admin; `note` says exactly what is missing
 *   boundary      the admin side is built but it cannot work without something outside the code — a provider,
 *                 credentials, hardware or an owner's decision; `note` names it. Never shown as working.
 *   planned       not usable in the admin yet. The commerce core may already do the work underneath (`note` says
 *                 what exists — a service, a database rule, a scheduled job); that alone does not make it implemented
 *
 * Every function id is required (the record is typed by the blueprint's ids, so a missing or misspelt id fails the
 * typecheck); tests/admin-shell.test.ts also checks that `route` points into the admin and that every non-planned
 * entry carries a note or a route.
 *
 *   // a module page renders the status of its functions until (and after) it is complete
 *   import { ModuleFunctions } from "~/routes/admin/blueprint-status";
 *   <ModuleFunctions moduleId="05" />
 */
import { createElement } from "react";
import { BLUEPRINT_FUNCTION_IDS, BLUEPRINT_MODULES, type BlueprintFunctionId, type BlueprintModuleDef } from "./shell/blueprint-catalog";
import { FunctionList, type FunctionListProps } from "./shell/FunctionList";

export type BlueprintStatus = "implemented" | "partial" | "boundary" | "planned";
export const BLUEPRINT_STATUSES = ["implemented", "partial", "boundary", "planned"] as const satisfies readonly BlueprintStatus[];

/** Shown to staff in the admin's language (Arabic first; the admin runs in ar and en). */
export type BlueprintNote = { ar: string; en: string };

export type BlueprintEntry = {
  status: BlueprintStatus;
  /** Where staff use it, an admin path ("/admin/orders/proofs"). */
  route?: string;
  note?: BlueprintNote;
};

const n = (en: string, ar: string): BlueprintNote => ({ ar, en });
const planned = (note?: BlueprintNote): BlueprintEntry => (note ? { status: "planned", note } : { status: "planned" });

/** The status of every blueprint function. Module owners: edit your own module's block only. */
export const BLUEPRINT_STATUS: Readonly<Record<BlueprintFunctionId, BlueprintEntry>> = {
  // ── 01 Command center (owner: dashboard module; the admin home is a minimal landing by the admin shell)
  "01.01": planned(n("Profit is defined in docs/metrics.md; the journal and cost-of-goods postings exist in the commerce core.", "تعريفات الربح مكتوبة، وقيود اليومية وتكلفة المبيعات موجودة في نواة التجارة.")),
  "01.02": {
    status: "partial",
    route: "/admin",
    note: n(
      "The admin home lists transfer proofs awaiting verification and refunds awaiting a second approval, to the employees who may act on them. Late orders, low stock and critical tickets are not listed, and the review screens belong to module 05.",
      "تعرض الصفحة الرئيسية إثباتات التحويل بانتظار التحقق والاستردادات بانتظار موافقة ثانية لمن يملك صلاحية التصرف بها. الطلبات المتأخرة والمخزون المنخفض والتذاكر الحرجة غير معروضة، وشاشات المراجعة من القسم 05.",
    ),
  },
  "01.03": planned(n("Conversion is not measurable yet: visits are not tracked.", "معدل التحويل غير قابل للقياس بعد، فالزيارات لا تُتتبع.")),
  "01.04": planned(),
  "01.05": planned(n("The shell already shows each role only its own modules and queues; role dashboards are not built.", "تعرض الواجهة لكل دور أقسامه وما ينتظره فقط، ولوحات الأدوار لم تُبنَ.")),
  "01.06": {
    status: "partial",
    route: "/admin",
    note: n(
      "Ctrl/⌘ K opens a palette of the modules, blueprint functions and actions the employee may use. Searching orders, customers, SKUs, serials and tickets is not built.",
      "يفتح Ctrl/⌘ K لوحة بحث في الأقسام ووظائف المخطط والإجراءات المسموحة للموظف. البحث في الطلبات والعملاء والأصناف والأرقام التسلسلية والتذاكر غير منفذ.",
    ),
  },
  "01.07": planned(n("Every change to stock, money, prices, permissions and settings is recorded in the audit trail.", "كل تغيير في المخزون والمال والأسعار والصلاحيات والإعدادات مسجل في سجل التدقيق.")),

  // ── 02 Product catalog
  "02.01": planned(n("Products and variants with their options exist in the database; the demo catalogue is seeded.", "المنتجات ومتغيراتها موجودة في قاعدة البيانات، والكتالوج التجريبي محمّل.")),
  "02.02": planned(n("The category tree exists and the storefront reads it.", "شجرة التصنيفات موجودة ويقرؤها المتجر.")),
  "02.03": planned(),
  "02.04": planned(n("Product photos come from the image pipeline; uploads are checked by content and stored privately.", "صور المنتجات تأتي من خط معالجة الصور، والملفات المرفوعة تُفحص بمحتواها وتُخزن بشكل خاص.")),
  "02.05": planned(n("The statuses draft, review, scheduled, published and archived exist in the database.", "حالات المسودة والمراجعة والجدولة والنشر والأرشفة موجودة في قاعدة البيانات.")),
  "02.06": planned(),
  "02.07": planned(n("Bundle components can be stored (bundle_items).", "يمكن تخزين مكونات الحزم.")),
  "02.08": planned(n("Tables for related products and compatibility rules exist.", "جداول المنتجات المرتبطة وقواعد التوافق موجودة.")),
  "02.09": planned(n("Product versions are append-only in the database.", "نسخ المنتج لا تقبل التعديل أو الحذف في قاعدة البيانات.")),
  "02.10": planned(),

  // ── 03 Pricing and profitability
  "03.01": planned(n("Protected cost rows and dated USD rates exist; cost leaves the server only for holders of cost.read.", "صفوف التكلفة المحمية وأسعار الصرف المؤرخة موجودة، ولا تخرج التكلفة من الخادم إلا لمن يملك صلاحيتها.")),
  "03.02": planned(n("FIFO cost layers carry the landed cost into the cost of goods sold.", "طبقات التكلفة FIFO تنقل التكلفة الواصلة إلى تكلفة المبيعات.")),
  "03.03": planned(),
  "03.04": planned(),
  "03.05": planned(n("Price changes are append-only; an approval is a new row.", "تغييرات الأسعار لا تقبل التعديل، والموافقة تُسجل سطراً جديداً.")),
  "03.06": planned(),
  "03.07": planned(),
  "03.08": planned(),

  // ── 04 Inventory and warehouses
  "04.01": planned(n("Stock per location and the quantity available to sell are computed in the commerce core.", "أرصدة كل موقع والكمية المتاحة للبيع تُحسب في نواة التجارة.")),
  "04.02": planned(n("Nested locations (warehouse, shelf, bin) with barcodes exist in the database.", "المواقع المتداخلة (مستودع، رف، صندوق) مع الباركود موجودة في قاعدة البيانات.")),
  "04.03": planned(n("Receiving exists in the commerce core (one serial per unit); there is no scanning screen.", "الاستلام موجود في نواة التجارة (رقم تسلسلي لكل قطعة)، ولا توجد شاشة مسح.")),
  "04.04": planned(n("Enforced in the database: stock movements reject edits and deletions.", "مطبّق في قاعدة البيانات: حركات المخزون ترفض التعديل والحذف.")),
  "04.05": planned(),
  "04.06": planned(),
  "04.07": planned(),
  "04.08": planned(n("Works automatically: unpaid reservations expire and are released every 5 minutes. No screen shows them.", "يعمل تلقائياً: الحجوزات غير المدفوعة تنتهي وتُحرر كل 5 دقائق. لا توجد شاشة تعرضها.")),
  "04.09": planned(n("Enforced by a database rule; selling into negative stock needs inventory.oversell.authorize and a reason.", "مطبّق بقاعدة في قاعدة البيانات، والبيع برصيد سالب يحتاج صلاحية وسبباً.")),
  "04.10": planned(n("FIFO cost layers are consumed when an order ships.", "طبقات التكلفة FIFO تُستهلك عند شحن الطلب.")),
  "04.11": planned(n("Shipping refuses an order until every serial-tracked unit is scanned.", "لا يُشحن الطلب قبل مسح كل قطعة لها رقم تسلسلي.")),
  "04.12": planned(),

  // ── 05 Orders and fulfillment
  "05.01": planned(n("The order state machine with all its side effects exists in the commerce core.", "آلة حالات الطلب بكل آثارها موجودة في نواة التجارة.")),
  "05.02": planned(),
  "05.03": planned(),
  "05.04": planned(),
  "05.05": planned(),
  "05.06": planned(),
  "05.07": planned(),
  "05.08": planned(n("Order events are append-only in the database.", "أحداث الطلب لا تقبل التعديل أو الحذف في قاعدة البيانات.")),
  "05.09": planned(n("Orders carry risk flags and customers a fraud flag in the database.", "الطلبات تحمل مؤشرات خطر والعملاء علامة احتيال في قاعدة البيانات.")),

  // ── 06 Point of sale
  "06.01": planned(),
  "06.02": planned(),
  "06.03": planned(),
  "06.04": planned(n("One stock ledger serves every channel; orders record whether they came from the web or the shop.", "دفتر مخزون واحد لكل القنوات، والطلب يسجل إن جاء من الموقع أو من المحل.")),
  "06.05": planned(),
  "06.06": planned(),
  "06.07": planned(),

  // ── 07 Customers and CRM
  "07.01": planned(),
  "07.02": planned(),
  "07.03": planned(n("Several addresses and notification preferences per customer exist in the database.", "العناوين المتعددة وتفضيلات الإشعارات لكل عميل موجودة في قاعدة البيانات.")),
  "07.04": planned(n("Consents are append-only in the database.", "سجل الموافقات لا يقبل التعديل أو الحذف في قاعدة البيانات.")),
  "07.05": planned(),
  "07.06": planned(),
  "07.07": planned(),

  // ── 08 Promotions and loyalty
  "08.01": planned(n("Coupon rules (fixed or percent, limits, dates) are applied at checkout by the commerce core.", "قواعد الكوبونات (مبلغ أو نسبة، حدود، تواريخ) تُطبق عند إتمام الطلب.")),
  "08.02": planned(),
  "08.03": planned(),
  "08.04": planned(n("The points ledger is append-only and cannot be overdrawn (database rule).", "دفتر النقاط لا يقبل التعديل ولا يُسحب منه أكثر من الرصيد.")),
  "08.05": planned(),
  "08.06": planned(),
  "08.07": planned(),
  "08.08": planned(),

  // ── 09 Suppliers and purchasing
  "09.01": planned(),
  "09.02": planned(),
  "09.03": planned(),
  "09.04": planned(),
  "09.05": planned(),
  "09.06": planned(),
  "09.07": planned(),
  "09.08": planned(),

  // ── 10 Finance and accounting
  "10.01": planned(n("A double-entry journal with balanced, sealed entries and standard postings exists in the commerce core.", "دفتر القيد المزدوج بقيود متوازنة ومختومة موجود في نواة التجارة.")),
  "10.02": planned(n("Cash-on-delivery collections and verified transfers are posted to the journal.", "تحصيل الدفع عند الاستلام والتحويلات المتحقق منها تُرحّل إلى الدفتر.")),
  "10.03": planned(n("Sales are posted when an order is delivered.", "المبيعات تُرحّل عند تسليم الطلب.")),
  "10.04": planned(n("Cost of goods at landed cost, discounts and refunds are posted (docs/metrics.md).", "تكلفة المبيعات بالتكلفة الواصلة والخصومات والاستردادات تُرحّل.")),
  "10.05": planned(),
  "10.06": planned(),
  "10.07": planned(n("Enforced: an append-only ledger with no balance column and a rule against overdrafts.", "مطبّق: دفتر لا يقبل التعديل، بلا عمود رصيد، مع قاعدة تمنع السحب الزائد.")),
  "10.08": planned(),
  "10.09": planned(n("Closed periods reject postings; there is no close screen.", "الفترات المغلقة ترفض الترحيل، ولا توجد شاشة إغلاق.")),
  "10.10": planned(n("Daily consistency checks store their findings; there is no screen.", "فحوصات الاتساق اليومية تخزن نتائجها، ولا توجد شاشة.")),

  // ── 11 Shipping and delivery
  "11.01": planned(n("Delivery is a flat 5,000 IQD to every governorate, overrides behind a setting; 19 governorates and 124 districts are seeded.", "التوصيل 5,000 د.ع لكل المحافظات والاستثناءات خلف إعداد، و19 محافظة و124 قضاء محمّلة.")),
  "11.02": planned(),
  "11.03": planned(),
  "11.04": planned(),
  "11.05": planned(n("A shipped order can come back with its goods restocked (commerce core).", "يمكن إرجاع طلب مشحون مع إعادة بضاعته إلى المخزون.")),
  "11.06": planned(),

  // ── 12 Returns and warranty
  "12.01": planned(),
  "12.02": planned(n("The return window is a setting (7 days).", "مهلة الإرجاع إعداد (7 أيام).")),
  "12.03": planned(),
  "12.04": planned(n("Refunds to the original method, the wallet or cash exist in the commerce core, with a second person's approval.", "الاسترداد إلى الوسيلة الأصلية أو المحفظة أو نقداً موجود في نواة التجارة، بموافقة شخص ثانٍ.")),
  "12.05": planned(n("Enforced by database rules: never more than was paid, never more units than were sold.", "مطبّق بقواعد قاعدة البيانات: لا أكثر مما دُفع ولا قطع أكثر مما بيع.")),
  "12.06": planned(n("Warranties start when an order is delivered.", "الضمان يبدأ عند تسليم الطلب.")),
  "12.07": planned(),

  // ── 13 Devices, games and trade-in
  "13.01": planned(n("A serial is sold once (unique, guarded status).", "الرقم التسلسلي يُباع مرة واحدة.")),
  "13.02": planned(n("Inspection checklists are seeded for consoles, handheld PCs, controllers and games.", "قوائم الفحص محمّلة للأجهزة المنزلية والمحمولة وأذرع التحكم والألعاب.")),
  "13.03": planned(),
  "13.04": planned(n("An estimate is never an offer: only an employee can set the final offer (database rule).", "التقدير ليس عرضاً: الموظف وحده يحدد العرض النهائي.")),
  "13.05": planned(),
  "13.06": planned(),
  "13.07": planned(),
  "13.08": planned(n("A used unit cannot be listed without the ownership check and data wipe dates (database rule).", "لا يُعرض جهاز مستعمل دون تاريخي التحقق من الملكية ومسح البيانات.")),
  "13.09": planned(n("Listing a used unit needs a real photo and a completed checklist (database rule).", "عرض جهاز مستعمل يحتاج صورة حقيقية وقائمة فحص مكتملة.")),

  // ── 14 Customer service
  "14.01": planned(n("No email or messaging provider is connected.", "لا يوجد مزود بريد أو رسائل متصل.")),
  "14.02": planned(),
  "14.03": planned(),
  "14.04": planned(),
  "14.05": planned(),
  "14.06": planned(n("Knowledge articles are stored as safe blocks; 8 demo articles are seeded.", "مقالات المعرفة تُخزن كأجزاء آمنة، و8 مقالات تجريبية محمّلة.")),
  "14.07": planned(),

  // ── 15 Staff and HR
  "15.01": planned(n("246 permissions in 24 groups and 8 built-in roles are installed; there is no role editor.", "246 صلاحية في 24 مجموعة و8 أدوار جاهزة مثبتة، ولا يوجد محرر أدوار.")),
  "15.02": planned(),
  "15.03": planned(),
  "15.04": planned(),
  "15.05": planned(),
  "15.06": planned(n("Refunds already need a second person's approval.", "الاسترداد يحتاج أصلاً موافقة شخص ثانٍ.")),
  "15.07": {
    status: "partial",
    route: "/admin/me",
    note: n(
      "Each employee sees and ends their own sessions on the My security page, and a disabled account is locked out on its next request. Staff cannot be disabled from the admin yet (the service exists), and nobody sees other employees' sessions.",
      "يرى كل موظف جلساته وينهيها من صفحة أماني، والحساب الموقوف يُمنع من أول طلب تالٍ. لا يمكن إيقاف موظف من لوحة الإدارة بعد (الخدمة موجودة)، ولا يرى أحد جلسات غيره.",
    ),
  },

  // ── 16 Marketing and growth
  "16.01": planned(n("No message provider is configured: messages are held and never reported as sent.", "لا يوجد مزود رسائل: الرسائل تُحجز ولا تُعدّ مرسلة.")),
  "16.02": planned(n("No message provider is configured.", "لا يوجد مزود رسائل.")),
  "16.03": planned(),
  "16.04": planned(),
  "16.05": planned(n("Recommendation rules (pin, exclude, boost) exist in the database.", "قواعد التوصيات (تثبيت، استبعاد، أولوية) موجودة في قاعدة البيانات.")),
  "16.06": planned(n("No reviews are collected yet, and none are invented.", "لا تُجمع تقييمات بعد، ولا تُختلق.")),
  "16.07": planned(),

  // ── 17 Content and storefront
  "17.01": planned(),
  "17.02": planned(),
  "17.03": planned(),
  "17.04": planned(n("A redirects table exists.", "جدول التحويلات موجود.")),
  "17.05": planned(),
  "17.06": planned(),

  // ── 18 Reports and BI
  "18.01": planned(),
  "18.02": planned(),
  "18.03": planned(),
  "18.04": planned(),
  "18.05": planned(),
  "18.06": planned(),
  "18.07": planned(n("The metrics dictionary is written (docs/metrics.md); it is not in the admin.", "قاموس المقاييس مكتوب، لكنه ليس في لوحة الإدارة.")),

  // ── 19 Automation and AI
  "19.01": planned(),
  "19.02": planned(),
  "19.03": planned(),
  "19.04": planned(),
  "19.05": planned(),
  "19.06": planned(),
  "19.07": planned(),
  "19.08": planned(n("Refunds already need approval by a second person.", "الاسترداد يحتاج أصلاً موافقة شخص ثانٍ.")),

  // ── 20 Security and compliance
  "20.01": {
    status: "partial",
    route: "/admin/me",
    note: n(
      "Two-step verification with an authenticator app and one-time recovery codes, password change, and the employee's own sessions with sign-out (one or all). Not built: trusted devices, requiring two-step verification for a role, and managing other employees' sessions.",
      "التحقق بخطوتين بتطبيق مصادقة ورموز استرداد لمرة واحدة، وتغيير كلمة المرور، وجلسات الموظف نفسه مع تسجيل الخروج (جلسة أو الكل). غير منفذ: الأجهزة الموثوقة، وفرض التحقق بخطوتين لدور، وإدارة جلسات الآخرين.",
    ),
  },
  "20.02": {
    status: "partial",
    route: "/admin",
    note: n(
      "Enforced on every admin request: the shell shows and opens only the modules a role may use, and every service checks again; cost and profit leave the server only with cost.read and profit.read. There is no role editor (15.01) and no branch screen.",
      "مطبّق على كل طلب في لوحة الإدارة: لا تظهر ولا تُفتح إلا أقسام الدور، وكل خدمة تتحقق مجدداً، ولا تخرج التكلفة والربح من الخادم إلا بصلاحيتيهما. لا يوجد محرر أدوار (15.01) ولا شاشة فروع.",
    ),
  },
  "20.03": planned(n("Append-only audit events in a hash chain sealed daily; there is no viewer.", "أحداث تدقيق لا تقبل التعديل في سلسلة مختومة يومياً، ولا توجد شاشة لعرضها.")),
  "20.04": planned(n("Authenticator secrets are encrypted (AES-256-GCM); digital codes are not built.", "أسرار تطبيق المصادقة مشفرة، والرموز الرقمية غير منفذة.")),
  "20.05": planned(n("No backup or restore test is set up from the app.", "لا يوجد نسخ احتياطي أو اختبار استعادة من التطبيق.")),
  "20.06": planned(n("Orders, payments, wallet entries and refunds are idempotent; inbound webhook ids are de-duplicated.", "الطلبات والمدفوعات وحركات المحفظة والاستردادات لا تتكرر، ومعرفات الإشعارات الواردة لا تُعالج مرتين.")),
  "20.07": planned(n("Retention of sessions, codes, sign-in events (180 days) and the outbox (90 days) runs daily; no settings screen or access review.", "حذف الجلسات والرموز وأحداث الدخول (180 يوماً) والرسائل (90 يوماً) يعمل يومياً، بلا شاشة إعدادات أو مراجعة صلاحيات.")),
  "20.08": planned(n("Every sign-in, failure and lockout is recorded; an email locks after 5 failures. There is no alert screen.", "كل دخول وفشل وإيقاف مسجل، ويُوقف البريد بعد 5 محاولات فاشلة. لا توجد شاشة تنبيهات.")),

  // ── 21 Branches, channels and integrations
  "21.01": planned(),
  "21.02": planned(),
  "21.03": planned(),
  "21.04": planned(),
  "21.05": planned(n("No payment, shipping or messaging provider is connected.", "لا يوجد مزود دفع أو شحن أو رسائل متصل.")),
  "21.06": planned(),

  // ── 22 Settings and administration
  "22.01": planned(n("Typed settings and dated USD rates exist, with audited changes.", "الإعدادات وأسعار الصرف المؤرخة موجودة، وتغييراتها مسجلة.")),
  "22.02": planned(n("Shipping, payment and return settings exist with defaults and owner-only keys.", "إعدادات الشحن والدفع والإرجاع موجودة بقيم افتراضية ومفاتيح للمالك فقط.")),
  "22.03": planned(),
  "22.04": planned(),
  "22.05": {
    status: "partial",
    route: "/admin",
    note: n(
      "The admin works in Arabic (right to left) and English, chosen per browser, and shows dates in Iraq time (Asia/Baghdad). There is no settings screen for the time zone, date or numeral formats.",
      "تعمل لوحة الإدارة بالعربية (من اليمين لليسار) والإنجليزية حسب المتصفح، وتعرض التواريخ بتوقيت العراق. لا توجد شاشة إعدادات للتوقيت أو صيغ التاريخ والأرقام.",
    ),
  },
  "22.06": planned(),

  // ── 23 Technical operations
  "23.01": planned(),
  "23.02": planned(),
  "23.03": planned(n("Scheduled jobs run every 5 minutes and daily, and every run is recorded; there is no screen.", "المهام المجدولة تعمل كل 5 دقائق ويومياً وكل تشغيل مسجل، ولا توجد شاشة.")),
  "23.04": planned(),
  "23.05": planned(),
  "23.06": planned(n("Consistency checks run daily and store their findings; there is no screen.", "فحوصات الاتساق تعمل يومياً وتخزن نتائجها، ولا توجد شاشة.")),
};

// ───────────────────────────────────────────────────────────────── helpers

export function statusOf(functionId: string): BlueprintEntry {
  return (BLUEPRINT_STATUS as Record<string, BlueprintEntry | undefined>)[functionId] ?? { status: "planned" };
}

export type StatusCounts = Record<BlueprintStatus, number> & { total: number };

/** How many of a module's functions are in each status (all modules when `moduleId` is omitted). */
export function statusCounts(moduleId?: string): StatusCounts {
  const counts: StatusCounts = { implemented: 0, partial: 0, boundary: 0, planned: 0, total: 0 };
  for (const id of BLUEPRINT_FUNCTION_IDS) {
    if (moduleId && !id.startsWith(`${moduleId}.`)) continue;
    counts[statusOf(id).status]++;
    counts.total++;
  }
  return counts;
}

/** The status table for docs/STATUS.md (English), one row per module plus every non-planned function. */
export function blueprintStatusMarkdown(): string {
  const lines = ["| Module | Priority | Implemented | Partial | Boundary | Planned |", "|---|---|---|---|---|---|"];
  for (const module of BLUEPRINT_MODULES as readonly BlueprintModuleDef[]) {
    const c = statusCounts(module.id);
    lines.push(`| ${module.id} ${module.en} | ${module.priority} | ${c.implemented} | ${c.partial} | ${c.boundary} | ${c.planned} |`);
  }
  const all = statusCounts();
  lines.push(`| **All** | | **${all.implemented}** | **${all.partial}** | **${all.boundary}** | **${all.planned}** |`, "");
  for (const module of BLUEPRINT_MODULES as readonly BlueprintModuleDef[]) {
    for (const fn of module.functions) {
      const entry = statusOf(fn.id);
      if (entry.status === "planned") continue;
      lines.push(`- ${fn.id} ${fn.en} — **${entry.status}**${entry.route ? ` (\`${entry.route}\`)` : ""}${entry.note ? `: ${entry.note.en}` : ""}`);
    }
  }
  return lines.join("\n");
}

export type ModuleFunctionsProps = Omit<FunctionListProps, "module" | "statuses"> & {
  /** Blueprint module id, "01" … "23". */
  moduleId: string;
};

/**
 * The status of a module's blueprint functions, in the admin's language — every module page renders it (the shell's
 * landing page until the module is built, and the module's own page after). Needs the "admin" strings, which the
 * admin layout always loads.
 */
export function ModuleFunctions({ moduleId, ...rest }: ModuleFunctionsProps) {
  const module = BLUEPRINT_MODULES.find((entry) => entry.id === moduleId);
  if (!module) return null;
  return createElement(FunctionList, { ...rest, module, statuses: BLUEPRINT_STATUS });
}
