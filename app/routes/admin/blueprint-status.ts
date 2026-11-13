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
  // ── 01 Command center (owner: dashboard module, docs/areas/admin-dashboard.md)
  "01.01": {
    status: "implemented",
    route: "/admin",
    note: n(
      "Paid sales, new orders, open orders and the average basket (docs/metrics.md) and net profit (the finance module's profit and loss; only with cost and profit permissions), each against the same span of the period before. Net profit is not available per branch: the books are kept for the whole store.",
      "المبيعات المدفوعة والطلبات الجديدة والمفتوحة ومتوسط السلة (قاموس المقاييس) وصافي الربح (الأرباح والخسائر من القسم المالي؛ لمن يملك صلاحيتي التكلفة والربح فقط)، كلٌّ مقابل المدة نفسها من الفترة السابقة. صافي الربح غير متاح لفرع واحد: الدفاتر للمتجر كله.",
    ),
  },
  "01.02": {
    status: "implemented",
    route: "/admin",
    note: n(
      "Late orders, mismatched payments (statement lines matching no payment), low stock and urgent tickets (and those past their due time): each tile counts what its module's own list shows the employee and opens it; below them, what waits for the employee's own decision (the bell's queues).",
      "الطلبات المتأخرة والدفعات غير المطابقة (سطور كشوف لا تطابق دفعة) والمخزون المنخفض والتذاكر العاجلة (وما تجاوز موعده): كل بطاقة تعدّ ما تعرضه قائمة قسمها للموظف وتفتحها، وتحتها ما ينتظر قرار الموظف نفسه (طوابير الجرس).",
    ),
  },
  "01.03": {
    status: "partial",
    route: "/admin",
    note: n(
      "Cart → order → paid → delivered from the store's own records, split by channel (website, point of sale), against the period before. Missing: the visit step (no analytics tool is connected — an owner's decision) and the split by device (carts and orders do not record the shopper's device — a schema change).",
      "السلة ← الطلب ← الدفع ← التسليم من سجلات المتجر نفسها، مقسّمة حسب القناة (الموقع، نقطة البيع)، مقابل الفترة السابقة. ينقص: خطوة الزيارة (لا أداة تحليلات مربوطة — قرار المالك) والتقسيم حسب الجهاز (السلال والطلبات لا تسجل جهاز المتسوق — تغيير في قاعدة البيانات).",
    ),
  },
  "01.04": {
    status: "implemented",
    route: "/admin?period=week",
    note: n(
      "Today, this week (from Saturday) and this month, each against the same span before, in Iraq time; demo data on request; a branch filter as soon as the store has branches (an employee limited to a branch sees their branch only).",
      "اليوم وهذا الأسبوع (من السبت) وهذا الشهر، كلٌّ مقابل المدة نفسها قبلها بتوقيت العراق؛ البيانات التجريبية عند الطلب؛ وفلتر الفرع حالما تكون للمتجر فروع (الموظف المقيّد بفرع يرى فرعه فقط).",
    ),
  },
  "01.05": {
    status: "implemented",
    route: "/admin?view=finance",
    note: n(
      "Role views — finance, warehouse, support — each shown only to employees holding the permissions of its cards, and each card only to holders of its own permission.",
      "لوحات حسب الدور — المالية والمخزن والدعم — تظهر كلٌّ منها لمن يملك صلاحيات بطاقاتها فقط، وكل بطاقة لمن يملك صلاحيتها.",
    ),
  },
  "01.06": {
    status: "implemented",
    route: "/admin/dashboard/search",
    note: n(
      "Orders, customers, SKUs, serial numbers and tickets with quick actions, each group by its module's permission and field rules. The Ctrl/⌘ K palette does not search records yet (asked of the admin shell owner).",
      "الطلبات والعملاء والأصناف والأرقام التسلسلية والتذاكر مع إجراءات سريعة، كل مجموعة بصلاحية قسمها وقواعد حقوله. لوحة Ctrl/⌘ K لا تبحث في السجلات بعد (مطلوب من مالك واجهة الإدارة).",
    ),
  },
  "01.07": {
    status: "implemented",
    route: "/admin/dashboard/activity",
    note: n(
      "Price changes, returns and approvals from the audit trail, each line shown only to employees who may open its record's module.",
      "تغييرات الأسعار والمرتجعات والموافقات من سجل التدقيق، ويظهر كل سطر لمن يملك فتح قسم سجله فقط.",
    ),
  },

  // ── 02 Product catalog
  "02.01": {
    status: "implemented",
    route: "/admin/catalog",
    note: n(
      "Product list with search by name, SKU, barcode (scanner) or model number and filters in the URL; parent product with SKU variants: platform, colour, capacity, edition, region, condition, model number, barcodes (one code names one variant), serial tracking. Prices are read-only here (module 03): a new variant of a product in the store starts switched off until it is priced.",
      "قائمة المنتجات مع البحث بالاسم أو SKU أو الباركود (الماسح) أو رقم الطراز ومرشحات في الرابط؛ منتج رئيسي ومتغيرات SKU: المنصة واللون والسعة والإصدار والمنطقة والحالة ورقم الطراز والباركود (الباركود الواحد لمتغير واحد) والتتبع التسلسلي. الأسعار للقراءة فقط هنا (القسم 03): المتغير الجديد لمنتج معروض يبدأ موقوفاً حتى يُسعَّر.",
    ),
  },
  "02.02": {
    status: "implemented",
    route: "/admin/catalog/categories",
    note: n(
      "Category tree up to four levels (order, names in three languages, switch off — with a reason and its impact shown when products in the store are under it —, delete only when empty); platforms, generations and device models at /admin/catalog/devices.",
      "شجرة تصنيفات حتى أربعة مستويات (الترتيب، الأسماء بثلاث لغات، الإيقاف — بسبب مع عرض أثره إذا كانت تحته منتجات معروضة —، الحذف للفارغ فقط)؛ والمنصات والأجيال وموديلات الأجهزة في /admin/catalog/devices.",
    ),
  },
  "02.03": {
    status: "implemented",
    route: "/admin/catalog",
    note: n(
      "Each product kind lists what it needs (compatibility, the store's warranty, age rating, region, licence type, format, bundle components, plus name, description, category, priced variant and picture); an incomplete product cannot be published or scheduled and a save never makes a live one less complete. Required custom fields from module 22 count too. The store's warranty terms are the owner's decision (STATUS item 15).",
      "لكل نوع منتج ما يلزمه (التوافق، ضمان المتجر، التصنيف العمري، المنطقة، نوع الترخيص، نوع النسخة، مكونات الحزمة، إضافة إلى الاسم والوصف والتصنيف ومتغير مسعّر وصورة)؛ المنتج الناقص لا يُنشر ولا يُجدول، والحفظ لا يجعل منتجاً معروضاً أنقص. والحقول المخصصة المطلوبة من القسم 22 تُحسب أيضاً. شروط ضمان المتجر قرار المالك.",
    ),
  },
  "02.04": {
    status: "partial",
    route: "/admin/catalog",
    note: n(
      "Several pictures per product and per variant: uploads through the upload service (stored public, 20 files per employee per 10 minutes), official catalogue photos by key, order, alt text in three languages, illustration flag. Missing: video (the upload service accepts images only and the media table has no URL column) and crop/focal hints (no columns) — schema change requested.",
      "صور متعددة للمنتج ولكل متغير: رفع عبر خدمة الرفع (تخزين عام، 20 ملفاً لكل موظف كل 10 دقائق)، صور الكتالوج الرسمية بمفتاحها، الترتيب، النص البديل بثلاث لغات، وعلامة الصورة التوضيحية. الناقص: الفيديو (خدمة الرفع تقبل الصور فقط وجدول الوسائط بلا عمود رابط) وتلميحات القص ونقطة التركيز (بلا أعمدة) — طُلب تعديل المخطط.",
    ),
  },
  "02.05": {
    status: "implemented",
    route: "/admin/catalog",
    note: n(
      "Draft, review, scheduled, published, hidden and archived, each move with its permission and reason; incomplete products cannot go live. A scheduled product opens on its own page and in the cart at its time, and the 5-minute job catalog.publish_due puts it in lists, search and menus within five minutes (or back to draft if it is no longer complete).",
      "مسودة ومراجعة وجدولة ونشر وإخفاء وأرشفة، لكل انتقال صلاحيته وسببه؛ والمنتج الناقص لا يُنشر. المنتج المجدول يفتح في صفحته وفي السلة في موعده، ومهمة الخمس دقائق catalog.publish_due تضيفه إلى القوائم والبحث والقوائم العلوية خلال خمس دقائق (أو تعيده مسودة إن لم يعد مكتملاً).",
    ),
  },
  "02.06": {
    status: "implemented",
    route: "/admin/catalog/import",
    note: n(
      "Bulk edit of selected products (fields and publishing moves) and CSV import with a full error preview (dry run), apply in guarded chunks and rollback per product; CSV export with the same columns (cost columns only with cost.read).",
      "تحرير جماعي للمنتجات المختارة (الحقول وانتقالات النشر) واستيراد CSV بمعاينة كاملة للأخطاء (تشغيل تجريبي) وتطبيق على دفعات محمية وتراجع لكل منتج؛ وتصدير CSV بنفس الأعمدة (أعمدة التكلفة فقط مع صلاحية التكلفة).",
    ),
  },
  "02.07": {
    status: "implemented",
    route: "/admin/catalog",
    note: n(
      "Bundle components per variant (typed or scanned SKU or barcode) with the stock of each component from the stock core: a bundle is available only as far as every component is, and the scarcest one is marked. One level only; components go only on bundle products, on variants that hold no stock of their own.",
      "مكونات الحزمة لكل متغير (SKU أو باركود مكتوب أو ممسوح) مع مخزون كل مكوّن من نواة المخزون: الحزمة متاحة بقدر كل مكوّن، ويُعلَّم الأندر. مستوى واحد فقط؛ والمكونات تُضاف لمنتجات الحزم التي لا تملك متغيراتها مخزوناً خاصاً بها.",
    ),
  },
  "02.08": {
    status: "implemented",
    route: "/admin/catalog",
    note: n(
      "Accessories, step-up, alternatives, upgrades and complete-your-setup links by product id, pinned and ordered; compatible accessories suggested from verified or partial rules on the product's device.",
      "ملحقات وترقية أعلى وبدائل وترقيات و«أكمل تجهيزك» بمعرّف المنتج، مع التثبيت والترتيب؛ واقتراح الملحقات المتوافقة من القواعد المتحقق منها أو الجزئية على جهاز المنتج.",
    ),
  },
  "02.09": {
    status: "implemented",
    route: "/admin/catalog",
    note: n(
      "Every save is a full version (who, when, why, what changed); compare any version with now; safe restore brings back texts and facts as a new version and never prices, costs, stock or status. Price history from module 03 shown read-only.",
      "كل حفظ نسخة كاملة (من ومتى ولماذا وما تغيّر)؛ مقارنة أي نسخة بالحالية؛ الاسترجاع الآمن يعيد النصوص والحقائق كنسخة جديدة ولا يعيد سعراً أو تكلفة أو مخزوناً أو حالة. سجل الأسعار من القسم 03 للقراءة.",
    ),
  },
  "02.10": {
    status: "implemented",
    route: "/admin/catalog/compare",
    note: n(
      "Compatibility rules per product or variant and device, generation or platform (verified needs a source and catalog.compatibility.verify; partial and incompatible need a note); all rules by device and status at /admin/catalog/compatibility; spec comparison of 2–4 devices with compatibility across generations.",
      "قواعد التوافق لكل منتج أو متغير وجهاز أو جيل أو منصة (المتحقق منه يحتاج مصدراً وصلاحية الاعتماد؛ الجزئي وغير المتوافق يحتاجان ملاحظة)؛ كل القواعد حسب الجهاز والحالة في /admin/catalog/compatibility؛ ومقارنة مواصفات 2–4 أجهزة مع التوافق عبر الأجيال.",
    ),
  },

  // ── 03 Pricing and profitability
  "03.01": {
    status: "implemented",
    route: "/admin/pricing/skus",
    note: n(
      "Each SKU's page records the supplier currency, the unit cost in it, the purchase rate and its date (the store's USD rate is the default) and the per-unit extras, giving the landed cost in exact dinars; cost leaves the server only for holders of cost.read, CSV included.",
      "صفحة كل صنف تسجل عملة المورد وتكلفة الوحدة بها وسعر صرف الشراء وتاريخه (سعر الدولار المعتمد هو الافتراضي) والإضافات للوحدة، فتخرج التكلفة الواصلة بالدينار بدقة؛ ولا تخرج التكلفة من الخادم إلا لمن يملك صلاحيتها، بما فيها ملف CSV.",
    ),
  },
  "03.02": {
    status: "partial",
    route: "/admin/pricing/landed",
    note: n(
      "Freight, customs, insurance, fees and commission bills are spread over a receipt's lines by value, quantity or weight, exact to the dinar, before the receipt is posted (purchasing 09 can call the same function). Receipts come from purchasing, which has no screens yet, and a bill that arrives after a receipt is posted needs a FIFO-layer revaluation the commerce core does not offer.",
      "توزَّع فواتير الشحن والجمارك والتأمين والرسوم والعمولات على بنود الاستلام حسب القيمة أو الكمية أو الوزن بالدينار الكامل قبل ترحيل الإيصال (ويستدعي قسم المشتريات 09 الدالة نفسها). الإيصالات تأتي من المشتريات التي لم تُبنَ شاشاتها بعد، والفاتورة التي تصل بعد الترحيل تحتاج إعادة تقييم طبقات FIFO غير متوفرة في نواة التجارة.",
    ),
  },
  "03.03": {
    status: "implemented",
    route: "/admin/pricing/skus",
    note: n(
      "Minimum and target margins per SKU (and in bulk). Every selling price is set here (the catalog leaves new variants unpriced and will not publish them so): a price under the minimum margin, under the landed cost or on a SKU without a cost waits for a second person, with the override right below the minimum.",
      "الحد الأدنى والهامش المستهدف لكل صنف (وبالجملة). كل سعر بيع يُحدَّد من هنا (الكتالوج يترك المتغيرات الجديدة بلا سعر ولا ينشرها كذلك): السعر تحت الحد الأدنى أو تحت التكلفة أو لصنف بلا تكلفة ينتظر شخصاً ثانياً، ومع صلاحية التجاوز تحت الحد الأدنى.",
    ),
  },
  "03.04": {
    status: "partial",
    route: "/admin/pricing/lists",
    note: n(
      "Price lists per sales channel, branch and customer segment, with quantity breaks, a time window and margin checks, are managed here. The cart, checkout and point of sale do not apply them yet (they price at the SKU's own price), and the product's condition is not a list dimension in the schema.",
      "قوائم الأسعار حسب قناة البيع والفرع وشريحة الزبائن، مع حدود الكمية ونافذة زمنية وفحص الهامش، تُدار هنا. السلة والدفع ونقطة البيع لا تطبقها بعد (تسعّر بسعر الصنف نفسه)، وحالة المنتج ليست بُعداً للقائمة في قاعدة البيانات.",
    ),
  },
  "03.05": {
    status: "implemented",
    route: "/admin/pricing/changes",
    note: n(
      "Every change is logged (append-only). A cut of more than 10% from the highest price of the last 30 days (so small cuts cannot add up past the limit), a new 'was' price, any price on a SKU without a cost and every clearance price wait for a second person; under the minimum margin also needs the override right; the requester never approves. The 10% limit is fixed until the settings registry has a key for it.",
      "كل تغيير مسجَّل ولا يُعدَّل. التخفيض بأكثر من 10% عن أعلى سعر خلال آخر 30 يوماً (فلا تتراكم تخفيضات صغيرة فوق الحد) والسعر السابق الجديد وأي سعر لصنف بلا تكلفة وكل سعر تصفية تنتظر شخصاً ثانياً، والسعر تحت الحد الأدنى يحتاج صلاحية التجاوز أيضاً، وصاحب الطلب لا يوافق عليه. حد 10% ثابت حتى يضاف مفتاح له في الإعدادات.",
    ),
  },
  "03.06": {
    status: "implemented",
    route: "/admin/pricing/simulate",
    note: n(
      "Net profit and margin per SKU before and after a discount: landed cost, the discount, refunds (the SKU's history or an assumption), payment or channel fees and the commission rules; totals over stock on hand, CSV with the same field rules.",
      "صافي الربح والهامش لكل صنف قبل الخصم وبعده: التكلفة الواصلة والخصم والاستردادات (من سجل الصنف أو مفترضة) ورسوم الدفع أو القناة وقواعد العمولة؛ مع الإجمالي على المخزون الحالي وملف CSV بقواعد الصلاحيات نفسها.",
    ),
  },
  "03.07": {
    status: "implemented",
    route: "/admin/pricing/special",
    note: n(
      "Bundles against their components (cost from the components when none is recorded), clearance candidates priced in clearance mode (floor at landed cost, always a second person) and used devices priced unit by unit under the same limits as SKUs: a deeper cut, or a price under the acquisition cost, waits for a second person (with the override right under the cost).",
      "الحزم مقابل مكوناتها (وتكلفتها من المكونات إن لم تُسجَّل)، والمرشحة للتصفية تسعَّر بنوع التصفية (الحد عند التكلفة الواصلة وشخص ثانٍ دائماً)، والأجهزة المستعملة جهازاً جهازاً بحدود الأصناف نفسها: التخفيض الأكبر أو السعر تحت تكلفة الاقتناء ينتظر شخصاً ثانياً (مع صلاحية التجاوز تحت التكلفة).",
    ),
  },
  "03.08": {
    status: "implemented",
    route: "/admin/pricing/skus",
    note: n(
      "On each SKU's page: a suggestion from fixed rules (cost and target margin, a market price staff type, slow stock) that only becomes a price through a request and its approval rules. No AI model and no market-price feed are connected.",
      "في صفحة كل صنف: اقتراح من قواعد ثابتة (التكلفة والهامش المستهدف، وسعر سوق يكتبه الموظف، والمخزون الراكد) لا يصير سعراً إلا عبر طلب يمر بقواعد الموافقة. لا نموذج ذكاء اصطناعي ولا مصدر لأسعار السوق مربوط.",
    ),
  },

  // ── 04 Inventory and warehouses
  "04.01": {
    status: "implemented",
    route: "/admin/inventory/stock",
    note: n(
      "Per SKU across all locations or at one: on hand, reserved, available to sell (sellable locations only), incoming (transfers in transit and approved purchase-order lines), filters and sorting in the URL; each SKU's page breaks it down by location. Value at cost for cost.read only.",
      "لكل صنف في كل المواقع أو في موقع واحد: الفعلي والمحجوز والمتاح للبيع (في المواقع المخصصة للبيع) والقادم (تحويلات في الطريق وأسطر أوامر شراء معتمدة)، والمرشحات والترتيب في الرابط؛ وصفحة كل صنف تفصّلها حسب الموقع. القيمة بالتكلفة لمن يملك صلاحيتها فقط.",
    ),
  },
  "04.02": {
    status: "implemented",
    route: "/admin/inventory/locations",
    note: n(
      "Warehouses and shops with aisles, shelves and bins inside (the level follows the depth), unique codes and barcodes, for-sale and active switches (refused while in use, with a reason), and printable labels (Code 128 and QR) from the browser.",
      "مستودعات ومتاجر وداخلها ممرات ورفوف وصناديق (المستوى حسب العمق)، ورموز وباركود فريدة، ومفاتيح للبيع والتفعيل (تُرفض والموقع مستخدم، مع سبب)، وملصقات قابلة للطباعة (Code 128 وQR) من المتصفح.",
    ),
  },
  "04.03": {
    status: "implemented",
    route: "/admin/inventory/receive",
    note: n(
      "Receiving sessions: a keyboard-wedge barcode/QR reader (or typing) finds the SKU, units are counted and inspected (rejected ones stay out with a reason), serial numbers are scanned one per unit, and the accepted units enter stock through the commerce core. Receiving against purchase orders and posting receipts to the books belong to purchasing (09).",
      "جلسات استلام: قارئ باركود/QR يعمل كلوحة مفاتيح (أو الكتابة) يجد الصنف، وتُعدّ القطع وتُفحص (المرفوض يبقى خارجاً مع سببه)، وتُمسح الأرقام التسلسلية رقماً لكل قطعة، ويدخل المقبول إلى المخزون عبر نواة التجارة. الاستلام مقابل أوامر الشراء وترحيله إلى الدفاتر من قسم المشتريات (09).",
    ),
  },
  "04.04": {
    status: "implemented",
    route: "/admin/inventory/movements",
    note: n(
      "Every receipt, sale, reservation, transfer, damage, adjustment and count with reason, reference, actor and time; filters in the URL and CSV export. The database refuses edits and deletions; there is no way to change a row. The log (also a SKU's latest rows and a unit's history) only for inventory.movement.read; unit costs only for cost.read, serial numbers only for inventory.serial.read.",
      "كل استلام وبيع وحجز وتحويل وتلف وتسوية وجرد مع السبب والمرجع والفاعل والوقت؛ والمرشحات في الرابط وتصدير CSV. قاعدة البيانات ترفض التعديل والحذف ولا توجد طريقة لتغيير سطر. السجل (ومنه آخر حركات الصنف وتاريخ القطعة) لمن يملك صلاحية سجل الحركات فقط؛ تكلفة القطعة لمن يملك صلاحية التكلفة فقط، والأرقام التسلسلية لمن يملك صلاحيتها فقط.",
    ),
  },
  "04.05": {
    status: "partial",
    route: "/admin/inventory/counts",
    note: n(
      "Periodic (every SKU at a location) and selective (chosen SKUs or a random sample) counts, blind for counters, with scanning; a supervisor who did not start or count approves, and the differences are posted through the commerce core (negative stock only with the oversell permission); an approval that stopped half way is finished by approving again, never posted twice. Missing: differences of serial-tracked items are shown (missing and unexpected serials) but not posted — the core has no single-serial write-off yet.",
      "جرد دوري (كل الأصناف في موقع) وانتقائي (أصناف مختارة أو عينة عشوائية)، أعمى للعادّين ومع المسح؛ يعتمده مشرف لم يبدأه ولم يعدّ فيه، وتُرحَّل الفروقات عبر نواة التجارة (الرصيد السالب فقط بصلاحية البيع بالسالب)؛ والاعتماد الذي توقف في منتصفه يُكمَل باعتماد جديد ولا يُرحَّل فرق مرتين. الناقص: فروقات الأصناف المتتبعة بالرقم التسلسلي تُعرض (المفقود وغير المتوقع) ولا تُرحَّل، فلا توجد بعد في النواة عملية لشطب رقم تسلسلي واحد.",
    ),
  },
  "04.06": {
    status: "implemented",
    route: "/admin/inventory/reorder",
    note: n(
      "Reorder point and order quantity per SKU and location (on the SKU's page), days of cover, stock-out date and a suggested quantity from real shipped sales, with the inputs shown and an honest \"not enough history\". Turning a suggestion into a purchase order is purchasing's (09).",
      "حد إعادة الطلب وكمية الطلب لكل صنف وموقع (في صفحة الصنف)، وأيام التغطية وتاريخ النفاد والكمية المقترحة من المبيعات المشحونة الفعلية، مع عرض المدخلات وعبارة صريحة «تاريخ قصير» عند غيابه. تحويل الاقتراح إلى أمر شراء من قسم المشتريات (09).",
    ),
  },
  "04.07": {
    status: "implemented",
    route: "/admin/inventory/transfers",
    note: n(
      "Draft, ship (serials scanned for tracked items), in transit (not sellable or packable), receive in one or several goes at the destination, close a shortfall with a reason, or cancel a draft. Cost layers travel with the units; reserved units never leave; each step is audited and idempotent.",
      "مسودة، ثم شحن (تُمسح الأرقام التسلسلية للأصناف المتتبعة)، ثم في الطريق (لا تُباع ولا تُجهَّز)، ثم استلام في الموقع الآخر دفعة أو دفعات، أو إغلاق العجز بسبب، أو إلغاء المسودة. طبقات التكلفة تنتقل مع القطع، ولا تُنقل قطع محجوزة، وكل خطوة مسجلة في التدقيق وآمنة من التكرار.",
    ),
  },
  "04.08": {
    status: "implemented",
    route: "/admin/inventory/reservations",
    note: n(
      "Stock held per order with its expiry (unpaid transfer orders) or \"until shipped or cancelled\"; holds past their time are released automatically by the scheduled job every 5 minutes; a manual release with a reason for orders not yet being packed.",
      "المخزون المحجوز لكل طلب مع مهلة انتهائه (طلبات التحويل غير المدفوعة) أو «حتى الشحن أو الإلغاء»؛ الحجوزات المنتهية تُحرَّر تلقائياً بالمهمة المجدولة كل 5 دقائق؛ وتحرير يدوي بسبب للطلبات التي لم تدخل التجهيز.",
    ),
  },
  "04.09": {
    status: "implemented",
    route: "/admin/inventory/oversell",
    note: n(
      "Checkout never oversells and the database refuses negative available stock. The only exception is an adjustment or a count approval that an employee with inventory.oversell.authorize requests explicitly, with a reason; the page lists negative levels now and every authorised exception with who and why.",
      "إتمام الطلب لا يبيع بالسالب أبداً وقاعدة البيانات ترفض الرصيد المتاح السالب. الاستثناء الوحيد تسوية أو اعتماد جرد يطلبه صراحة موظف يملك صلاحية السماح بالبيع بالسالب مع سبب؛ والصفحة تعرض الأرصدة السالبة الآن وكل استثناء مصرّح به ومن أذن به ولماذا.",
    ),
  },
  "04.10": {
    status: "partial",
    route: "/admin/inventory/costing",
    note: n(
      "Batch tracking with FIFO costing per location: every received batch is a cost layer (landed cost, date, source), consumed oldest first by sales, transfers and write-offs, shown to cost.read only. Missing: there is no weighted-average policy to choose — FIFO is the only costing method.",
      "تتبع الدفعات بتكلفة FIFO لكل موقع: كل دفعة مستلمة طبقة تكلفة (تكلفة واصلة وتاريخ ومصدر) يُستهلك الأقدم منها أولاً في البيع والنقل والشطب، وتظهر لمن يملك صلاحية التكلفة فقط. الناقص: لا توجد سياسة متوسط مرجح للاختيار، فـ FIFO هي طريقة التكلفة الوحيدة.",
    ),
  },
  "04.11": {
    status: "implemented",
    route: "/admin/orders/fulfillment",
    note: n(
      "Packing station per order (module 05): a barcode/QR scanner types into the field (keyboard wedge); serials are attached through the core and checked against the line (a used device takes only its own unit's serial), a bundle is verified component by component, wrong items are refused and written down, and the order ships only when every unit is verified. A unit without a serial can be confirmed by hand with a reason, which is recorded and audited.",
      "محطة تجهيز لكل طلب (القسم 05): الماسح يكتب في الحقل كلوحة مفاتيح، والأرقام التسلسلية تُربط عبر النواة وتُطابق مع الصنف (الجهاز المستعمل يقبل رقم قطعته فقط)، والحزمة يُتحقق منها مكوّناً مكوّناً، والصنف الخطأ يُرفض ويُسجَّل، ولا يُشحن الطلب قبل التحقق من كل قطعة. القطعة التي بلا رقم تسلسلي يمكن تأكيدها يدوياً مع سبب يُسجَّل في السجل.",
    ),
  },
  "04.12": {
    status: "implemented",
    route: "/admin/inventory/reports",
    note: n(
      "Dead stock (no sale in 30–365 days), turnover in units (sold ÷ average on hand, days of inventory) and sales versus inbound per SKU and per period, from the actual movements, with CSV export; value and cost of goods sold for cost.read only.",
      "المخزون الراكد (بلا بيع خلال 30 إلى 365 يوماً)، ودوران المخزون بالقطع (المبيع ÷ متوسط الفعلي، وأيام المخزون)، والمبيعات مقابل الوارد لكل صنف ولكل فترة، من الحركات الفعلية مع تصدير CSV؛ القيمة وتكلفة المبيعات لمن يملك صلاحية التكلفة فقط.",
    ),
  },

  // ── 05 Orders and fulfillment
  "05.01": {
    status: "implemented",
    route: "/admin/orders",
    note: n(
      "New, awaiting payment, under verification, confirmed (paid), preparing, shipped, delivered, cancelled, returned — changed only through the core's state machine, with the stock and money impact shown before confirming and a reason for cancelling or returning.",
      "جديد، بانتظار الدفع، قيد التحقق، مؤكد (مدفوع)، قيد التجهيز، تم الشحن، تم التسليم، ملغى، مرتجع — لا تتغير إلا عبر آلة الحالات في النواة، مع عرض أثرها على المخزون والمال قبل التأكيد وسبب للإلغاء والإرجاع.",
    ),
  },
  "05.02": { status: "implemented", route: "/admin/orders" },
  "05.03": { status: "implemented", route: "/admin/orders/fulfillment" },
  "05.04": {
    status: "partial",
    route: "/admin/orders/fulfillment",
    note: n(
      "An order can be divided into several parcels, each with its own packing slip and label, but all parcels leave together: the commerce core commits an order's stock in one step, so shipping part of an order ahead of the rest needs a partial commit in the core.",
      "يمكن تقسيم الطلب إلى عدة طرود لكل منها قائمة تعبئة وملصق، لكن الطرود تخرج معاً: نواة التجارة تُخرج مخزون الطلب دفعة واحدة، وشحن جزء قبل الباقي يحتاج إخراجاً جزئياً في النواة.",
    ),
  },
  "05.05": {
    status: "partial",
    route: "/admin/orders",
    note: n(
      "Quantities (0 removes a line) and the address change before shipping, with the payment due, the coupon and the stock recalculated and shown first — for orders not paid yet (cash on delivery, a transfer still awaited). A paid order's lines and total cannot change: its refund would need to be booked as a price change, which the core's delivery posting does not tell apart. Once its invoice is issued an order keeps its lines and total (no credit note and re-invoice yet), and a line never goes below the units already scanned at the packing station. Adding new products is not offered.",
      "تتغير الكميات (0 يحذف السطر) والعنوان قبل الشحن مع إعادة حساب المستحق والقسيمة والمخزون وعرضها أولاً — للطلبات غير المدفوعة بعد (الدفع عند الاستلام، أو تحويل لم يصل). الطلب المدفوع لا تتغير سطوره ولا مبلغه: استرداد الفرق يحتاج تسجيله كتغيير سعر، وقيد التسليم في النواة لا يميّز ذلك. بعد إصدار فاتورة الطلب تبقى سطوره ومبلغه كما هي (لا إشعار دائن وإعادة فوترة بعد)، ولا تنقص كمية السطر عن القطع الممسوحة في محطة التجهيز. إضافة منتجات جديدة غير متاحة.",
    ),
  },
  "05.06": {
    status: "boundary",
    route: "/admin/orders/print",
    note: n(
      "Invoices (numbered once), packing slips and shipping labels with a barcode print from the browser, one order or a batch. Customer notifications are written to the outbox and held: no SMS or WhatsApp provider is connected.",
      "الفواتير (برقم يصدر مرة واحدة) وقوائم التعبئة وملصقات الشحن بالباركود تُطبع من المتصفح لطلب أو دفعة. إشعارات العميل تُكتب وتبقى محجوزة: لا يوجد مزوّد رسائل SMS أو واتساب.",
    ),
  },
  "05.07": {
    status: "partial",
    route: "/admin/orders/preorders",
    note: n(
      "Pre-orders with an expected date and delay updates (recorded, with a held message to the customer). Deposits are shown as the catalogue sets them but not taken: checkout charges the whole total, and a deposit needs a split payment in the core and the checkout.",
      "الطلبات المسبقة بموعد متوقع وتحديثات تأخير (تُسجَّل مع رسالة محجوزة للعميل). الدفعة المقدمة معروضة كما في الكتالوج ولا تُؤخذ: الدفع عند الطلب بالمجموع كاملاً، والدفعة المقدمة تحتاج دفعاً مجزأً في النواة وصفحة الدفع.",
    ),
  },
  "05.08": {
    status: "implemented",
    route: "/admin/orders",
    note: n(
      "Each order's history (who, what, why) and its notification log — held messages are shown as not sent; the receipt signature is a photo of the signed slip, kept as a private proof of delivery with the receiver's name.",
      "سجل كل طلب (من وماذا ولماذا) وسجل إشعاراته — الرسائل المحجوزة تظهر كغير مرسلة؛ توقيع الاستلام صورة للوصل الموقّع تُحفظ بشكل خاص كإثبات تسليم مع اسم المستلم.",
    ),
  },
  "05.09": {
    status: "implemented",
    route: "/admin/orders/review",
    note: n(
      "Twelve deterministic rules (late or suspicious), each flag with the sentence that explains it; a person clears it, holds the order, or asks for a review — asking never lifts a hold. The hold is enforced by this module's screens (confirm, pack, ship, deliver, approve a proof); the commerce core does not know it yet.",
      "اثنتا عشرة قاعدة ثابتة (تأخير أو اشتباه)، ولكل علامة جملة تشرح سببها؛ يقرر شخص: سليم، أو إيقاف الطلب، أو طلب مراجعة — وطلب المراجعة لا يرفع الإيقاف. الإيقاف تطبّقه شاشات هذا القسم (التأكيد والتجهيز والشحن والتسليم واعتماد الإثبات)، ونواة التجارة لا تعرفه بعد.",
    ),
  },

  // ── 06 Point of sale
  "06.01": {
    status: "implemented",
    route: "/admin/pos/sell",
    note: n(
      "The till reads a barcode scanner as a keyboard (SKU, barcode, extra barcodes, serial number) and prints the receipt in place from the browser on 80 mm paper, with the sale's barcode. The first print is the original; every later print is a marked, numbered copy, recorded.",
      "يقرأ الكاشير قارئ الباركود كلوحة مفاتيح (رمز SKU والباركود والباركودات الإضافية والرقم التسلسلي)، ويطبع الإيصال من الصفحة نفسها عبر المتصفح على ورق 80 مم مع باركود البيع. الطبعة الأولى هي الأصل؛ وكل طبعة بعدها نسخة معلَّمة ومرقّمة ومسجلة.",
    ),
  },
  "06.02": {
    status: "implemented",
    route: "/admin/pos/shift",
    note: n(
      "Shifts open on a register with a counted float; cash moves in and out with a reason; closing is a blind count by note — also when a supervisor works the till: nobody sees their own drawer's expected cash. A difference is approved by a second person (never who opened or closed the shift) and posted once to cash over/short; each shift has a printable report.",
      "تُفتح الوردية على جهاز برصيد افتتاح معدود، ويُسجَّل الإيداع والسحب بسبب، ويُغلق الدرج بجرد أعمى حسب الفئة — وكذلك حين يعمل مشرف على الكاشير: لا يرى أحد النقد المتوقع في درجه. يعتمد الفرق شخص ثانٍ (ليس من فتح الوردية أو أغلقها) ويُقيَّد مرة واحدة في عجز وزيادة الصندوق، ولكل وردية تقرير قابل للطباعة.",
    ),
  },
  "06.03": {
    status: "boundary",
    route: "/admin/pos/sell",
    note: n(
      "Cash, wallet and mixed payments work at the till. A card is charged on the bank's own terminal and recorded here by its slip number: no card terminal or gateway is connected (a provider and its credentials are needed). Wallet spending is confirmed by the cashier, not by an SMS code (no SMS provider); the balance shows only to roles allowed to see wallets.",
      "الدفع نقداً ومن المحفظة والدفع المختلط يعمل في الكاشير. البطاقة تُدفع على جهاز البنك نفسه ويُسجَّل رقم إيصاله هنا: لا يوجد ربط بجهاز البطاقة أو ببوابة دفع (يلزم مزوّد وبيانات اعتماد). والدفع من المحفظة يتحقق منه الكاشير، لا رمز برسالة (لا مزوّد رسائل)؛ ولا يظهر الرصيد إلا لمن له صلاحية رؤية المحافظ.",
    ),
  },
  "06.04": {
    status: "implemented",
    route: "/admin/pos/sell",
    note: n(
      "The shop sells the same stock as the website through the commerce core: each sale reserves and commits at the register's store location in one step, the website's availability changes at once, and units held for web orders are never sold at the till.",
      "يبيع المحل من مخزون الموقع نفسه عبر نواة التجارة: كل بيع يحجز ويُخرج من موقع متجر الجهاز في خطوة واحدة، فيتغير المتاح في الموقع فوراً، ولا يُباع في الكاشير ما هو محجوز لطلبات الموقع.",
    ),
  },
  "06.05": {
    status: "implemented",
    route: "/admin/pos/sell",
    note: n(
      "A sale links to the buyer's account (found by phone) or keeps their phone; serial numbers are scanned and assigned through the core (never sold twice); warranties start at the sale, one per serial. New products carry a warranty term only once the owner sets the store's terms; used devices carry their own days.",
      "يُربط البيع بحساب العميل (بالبحث بالهاتف) أو يُحفظ هاتفه؛ تُمسح الأرقام التسلسلية وتُخصَّص عبر نواة التجارة (لا يُباع رقم مرتين)؛ ويبدأ الضمان عند البيع، ضمان لكل رقم. المنتجات الجديدة تحمل مدة ضمان حين يحدد المالك شروط المتجر؛ والأجهزة المستعملة تحمل أيامها.",
    ),
  },
  "06.06": {
    status: "implemented",
    route: "/admin/pos/sell",
    note: n(
      "Prices come from the point-of-sale price lists (branch, segment, quantity breaks) or the SKU's price. A cashier gives at most 10 % per line and per sale, never under the margin floor (a bundle: its components' cost), always with a reason; beyond needs the discount-override permission. The 10 % is a constant until settings has a key.",
      "الأسعار من قوائم أسعار نقطة البيع (الفرع والشريحة وكسور الكمية) أو سعر القطعة. يعطي الكاشير خصماً حتى 10% لكل بند وللبيع كله، ولا ينزل تحت حد الهامش (والمجموعة: تحت كلفة مكوّناتها)، ومع سبب دائماً؛ وما فوق ذلك يحتاج صلاحية تجاوز الخصم. نسبة 10% ثابتة حتى يُضاف مفتاح في الإعدادات.",
    ),
  },
  "06.07": {
    status: "partial",
    route: "/admin/pos/sell",
    note: n(
      "An open till keeps selling without a connection from the catalogue kept on the device; each sale keeps the key it got when charged, so syncing twice records it once; stock, prices and serials are confirmed on sync and conflicts wait for a person (only a supervisor drops a queued sale, with a reason). Missing: no service worker caches the app (the page must be open before the connection drops); no wallet or used devices offline.",
      "يبقى الكاشير المفتوح يبيع دون اتصال من الكتالوج المحفوظ على الجهاز؛ لكل بيع معرّفه منذ الدفع فلا يُسجَّل مرتين عند المزامنة؛ ويؤكد الخادم المخزون والأسعار والأرقام التسلسلية عند المزامنة وتنتظر التعارضات قرار شخص (ولا يحذف بيعاً محفوظاً إلا مشرف، مع سبب). الناقص: لا يوجد Service Worker يحفظ التطبيق (يجب أن تكون الصفحة مفتوحة قبل انقطاع الاتصال)، ولا محفظة ولا أجهزة مستعملة دون اتصال.",
    ),
  },

  // ── 07 Customers and CRM
  "07.01": {
    status: "implemented",
    route: "/admin/customers",
    note: n(
      "One page per customer: what they bought and kept, orders, returns (module 12's RMAs), warranties, repairs, support tickets, the wallet (the ledger sum; top-ups and adjustments open in Finance), append-only internal notes, consents and privacy requests, merged accounts and what staff changed. Each section only for the permission of the module that owns it; the full phone only with customer.phone.read_full. Tickets are read here until module 14 is built.",
      "صفحة لكل عميل: ما اشتراه وما بقي له، الطلبات، المرتجعات (طلبات الإرجاع من القسم 12)، الضمانات، الصيانة، تذاكر الدعم، المحفظة (مجموع الدفتر؛ الشحن والتسويات تُفتح في المالية)، ملاحظات داخلية لا تُعدَّل، الموافقات وطلبات الخصوصية، الحسابات المدموجة وما غيّره الموظفون. كل قسم لمن يملك صلاحية القسم المالك له فقط، والرقم كاملاً مع صلاحية رؤية الرقم كاملاً فقط. التذاكر تُقرأ هنا حتى يُبنى القسم 14.",
    ),
  },
  "07.02": {
    status: "implemented",
    route: "/admin/customers/segments",
    note: n(
      "Recency, frequency and value scored 1–5 from real orders (paid and not refunded in full), ten segments from written rules, stored membership next to what the orders say now, a recency × frequency grid, recomputed on demand in one audited batch, a segment filter on the list. The bounds are module constants until settings 22 owns them; no scheduled recompute yet.",
      "الحداثة والتكرار والقيمة من 1 إلى 5 من الطلبات الحقيقية (المدفوعة وغير المستردة كاملاً)، عشر شرائح بقواعد مكتوبة، الشريحة المحفوظة بجانب ما تقوله الطلبات الآن، شبكة الحداثة × التكرار، إعادة حساب عند الطلب في دفعة واحدة مسجلة، وتصفية القائمة بالشريحة. الحدود ثابتة في القسم حتى يملكها قسم الإعدادات 22، ولا إعادة حساب مجدولة بعد.",
    ),
  },
  "07.03": {
    status: "implemented",
    route: "/admin/customers",
    note: n(
      "Name, e-mail and message language, several addresses (one default, the checkout's own governorates and districts, at most 10), address phones masked without the full-phone permission, and the notification channels — each change with a reason, audited before/after, guarded against two people editing at once. The account phone is the sign-in identity and is not changed here (it needs an SMS code; no provider); channel choices are stored and delivered once a provider is connected.",
      "الاسم والبريد ولغة الرسائل، وعناوين متعددة (واحد افتراضي، من محافظات وأقضية إتمام الطلب نفسها، حتى 10)، وهواتف العناوين مخفية جزئياً دون صلاحية الرقم كاملاً، وقنوات الإشعارات — كل تغيير بسبب ومسجل قبل/بعد، ومحمي من تعديل شخصين معاً. رقم الحساب هو هوية الدخول ولا يُغيَّر هنا (يحتاج رمزاً برسالة نصية ولا يوجد مزوّد)، واختيار القنوات يُحفظ ويُرسل عند ربط مزوّد.",
    ),
  },
  "07.04": {
    status: "partial",
    route: "/admin/customers/privacy",
    note: n(
      "The consent log (every grant and withdrawal, its source and policy version; unsubscribes), withdrawals recorded at the customer's request (never a grant), and privacy requests opened on the customer's behalf with a due date: verified first (method and note), then a JSON export built at download while the request is open and audited each time, an erasure that follows the retention rules (personal data erased, the account anonymized, every consent still granted withdrawn — also the person's checkout answers as a guest; orders, payments, the wallet ledger, consents and the audit trail kept; refused while orders, returns or repairs are open), an unsubscribe (the account's and its guest checkouts' answers), or a correction. Missing: an account whose wallet holds money cannot be erased — the admin has no way to pay a wallet out (module 10's adjustments are credits; the commerce core has no wallet debit), so the request waits until the customer spends it. Customers cannot file a request from the storefront yet, and the file is handed over by hand (no e-mail provider).",
      "سجل الموافقات (كل موافقة وسحب ومصدرها ونسخة السياسة؛ إلغاءات الاشتراك)، وتسجيل السحب بطلب العميل (لا منح أبداً)، وطلبات الخصوصية تُفتح نيابة عن العميل بموعد: التحقق أولاً (الطريقة وملاحظة)، ثم ملف JSON يُبنى عند التنزيل ما دام الطلب مفتوحاً ويُسجَّل كل تنزيل، أو حذف يتبع قواعد الاحتفاظ (تُمحى البيانات الشخصية ويُجهَّل الحساب وتُسحب كل موافقة قائمة — ومنها ما وافق عليه كزائر عند الشراء؛ وتبقى الطلبات والمدفوعات ودفتر المحفظة والموافقات وسجل التدقيق، ويُرفض ما دامت طلبات أو مرتجعات أو صيانة مفتوحة)، أو إلغاء اشتراك (موافقات الحساب ومشترياته كزائر)، أو تصحيح. الناقص: لا يُحذف حساب في محفظته رصيد — لا توجد في لوحة الإدارة طريقة لصرف المحفظة (تسويات القسم 10 إضافة فقط، ولا خصم من المحفظة في نواة التجارة)، فينتظر الطلب حتى يصرف العميل رصيده. لا يستطيع العميل تقديم الطلب من المتجر بعد، ويُسلَّم الملف يدوياً (لا مزوّد بريد).",
    ),
  },
  "07.05": {
    status: "partial",
    route: "/admin/customers/duplicates",
    note: n(
      "Look-alike accounts with their reason (same e-mail, one account's number on the other's orders or addresses, same name and area); a plan of what moves and what stays before anyone confirms; the verification method, a note and a reason; one batch moving orders (each with an order event), addresses, favourites, saved devices, notifications, returns, warranties, repairs, tickets, trade-ins, coupon uses and reviews, ending the duplicate's sessions; two audit events with the moved order numbers. A blocked or fraud-flagged duplicate only folds into an account carrying the same label, so a merge never drops a block or a fraud flag. Missing: a duplicate whose wallet holds money (or a pending top-up or adjustment, or loyalty points) cannot be merged — the wallet is never rewritten and the commerce core has no wallet transfer yet.",
      "حسابات متشابهة مع السبب (البريد نفسه، أو رقم أحدها على طلبات الآخر أو عناوينه، أو الاسم والمنطقة)؛ خطة بما ينتقل وما يبقى قبل التأكيد؛ طريقة التحقق وملاحظة وسبب؛ دفعة واحدة تنقل الطلبات (لكل منها حدث في الطلب) والعناوين والمفضلة والأجهزة والإشعارات والمرتجعات والضمانات والصيانة والتذاكر والمقايضات واستعمالات القسائم والتقييمات، وتنهي جلسات الحساب المكرر؛ حدثا تدقيق بأرقام الطلبات المنقولة. الحساب المكرر المحظور أو الموسوم بخطر احتيال لا يُدمج إلا في حساب يحمل الوسم نفسه، فلا يضيع حظر ولا وسم احتيال بالدمج. الناقص: لا يُدمج حساب في محفظته رصيد (أو طلب شحن أو تسوية معلقة أو نقاط ولاء) — المحفظة لا يُعاد كتابتها ولا توجد بعد حركة نقل بين محفظتين في نواة التجارة.",
    ),
  },
  "07.06": {
    status: "implemented",
    route: "/admin/customers?view=risk",
    note: n(
      "VIP (a manual label, or value or frequency over 365 days), fraud risk (a manual flag with its reason — the orders module then sends the customer's orders to human review —, cancelled or returned orders, rejected or duplicate transfer proofs) and open complaints (complaint or escalated tickets), each label with the sentence and the numbers behind it; saved views and cards on the module page; block / unblock with a reason. The thresholds are module constants until settings 22 owns them.",
      "مميز (وسم يدوي، أو قيمة أو تكرار خلال 365 يوماً)، وخطر احتيال (وسم يدوي بسببه — وعندها يرسل قسم الطلبات طلبات العميل للمراجعة البشرية —، وطلبات ملغاة أو مُعادة، وإثباتات تحويل مرفوضة أو مكررة)، وشكاوى مفتوحة (تذاكر شكوى أو مصعّدة)، ولكل وسم الجملة والأرقام التي وراءه؛ عروض محفوظة وبطاقات في صفحة القسم؛ وحظر الحساب ورفعه بسبب. الحدود ثابتة في القسم حتى يملكها قسم الإعدادات 22.",
    ),
  },
  "07.07": {
    status: "implemented",
    route: "/admin/customers",
    note: n(
      "Each customer's communication log, filterable by order: the messages the store wrote (only the facts of the event — amounts, payment references and refusal reasons are left out) and the contacts staff logged by hand (append-only; card-like numbers refused). No SMS, WhatsApp or e-mail provider is connected, so every message shows as held, never as delivered.",
      "سجل تواصل كل عميل، مع التصفية بالطلب: الرسائل التي كتبها المتجر (وقائع الحدث فقط — بلا مبالغ ولا مراجع دفع ولا أسباب رفض) والاتصالات التي سجّلها الموظفون يدوياً (لا تُعدَّل، وتُرفض الأرقام التي تشبه بطاقة). لا يوجد مزوّد رسائل نصية أو واتساب أو بريد، فكل رسالة تظهر محجوزة ولم تُرسل.",
    ),
  },

  // ── 08 Promotions and loyalty
  "08.01": {
    status: "implemented",
    route: "/admin/promotions/coupons",
    note: n(
      "Fixed or percentage coupons with a total and a per-customer usage limit, a validity period and conditions (platform, category, product kind, segment, channel, first order, quantity); the commerce core validates and redeems them at checkout. promotions.coupon.manage creates; terms above 20 %, above 50,000 IQD off one order (or uncapped) or without any usage limit are switched on only after another employee holding pricing.discount.override approves — never the requester. Saved views, bulk switch-off, uses and discount given, \"try this coupon\" through the core's own evaluation, history.",
      "كوبونات بمبلغ أو نسبة مع حد كلي وحد لكل عميل وفترة صلاحية وشروط (منصة، تصنيف، نوع منتج، شريحة، قناة، أول طلب، كمية)، ونواة التجارة تتحقق منها وتسجّل استخدامها عند الدفع. يُنشئها من يملك إدارة الكوبونات؛ الشروط فوق 20% أو فوق 50,000 د.ع للطلب الواحد (أو بلا سقف) أو بلا حد للاستخدام لا تُشغّل إلا بموافقة موظف آخر يملك تجاوز حدود الخصم، ولا يعتمد أحد طلبه. عروض محفوظة وإيقاف جماعي والاستخدام والخصم المعطى وتجربة الكوبون بقاعدة النواة نفسها والسجل.",
    ),
  },
  "08.02": {
    status: "partial",
    route: "/admin/promotions/rules",
    note: n(
      "Rules by category, segment, cart value, quantity, platform and channel (percent, fixed, tiers, buy X get Y, free delivery), the second person beyond the limits, and a dry run over the recent orders. The online checkout applies the rules that are on (the commerce core: the rules that combine with coupons add up by priority, then the coupon; the best rule that does not combine competes with all of them together and applies alone when it gives more; free-delivery rules either way) and records each in the order's promotions event. Missing: the point of sale applies no rule (a rule limited to the point of sale applies nowhere).",
      "قواعد بحسب التصنيف والشريحة وقيمة السلة والكمية والمنصة والقناة (نسبة، مبلغ، شرائح، اشترِ واحصل، توصيل مجاني)، مع شخص ثانٍ فوق الحدود وتجربة على الطلبات الأخيرة. الدفع في الموقع يطبّق القواعد المشغّلة (نواة التجارة: القواعد التي تجتمع مع الكوبونات تُجمع بحسب الأولوية ثم الكوبون، وأفضل قاعدة لا تجتمع معها تنافسها كلها معاً وتُطبَّق وحدها إن أعطت أكثر، وقواعد التوصيل المجاني في الحالتين) ويسجّل كل قاعدة في سجل عروض الطلب. الناقص: نقطة البيع لا تطبّق أي قاعدة (والقاعدة المحصورة بنقطة البيع لا تنطبق في أي مكان).",
    ),
  },
  "08.03": {
    status: "partial",
    route: "/admin/promotions/flash",
    note: n(
      "Sales with a start and an end (Baghdad time), a price and an allowance per SKU, prices checked by the pricing module's own rules (the cut measured from the 30-day high, a second person, an override under the margin floor — evaluated again at the decision; cost signals only with profit.read), allowances never above the stock available, overlaps refused. The online cart and checkout sell at the running sale's price while the allowance and the per-customer limit last; placeOrder claims the units in its batch and a cancellation gives them back. Missing: product pages, lists and search still show the regular price (the sale price shows from the cart on); the point of sale sells at its own prices.",
      "عروض ببداية ونهاية (بتوقيت بغداد) وسعر وكمية مخصصة لكل صنف، والأسعار تُفحص بقواعد التسعير نفسها (الخصم من أعلى سعر في 30 يوماً، وشخص ثانٍ، وتجاوز تحت حد الهامش — وتُفحص مجدداً عند القرار؛ وإشارات التكلفة لمن يملك صلاحية الربح فقط)، والكمية لا تتجاوز المتوفر، والتداخل مرفوض. السلة والدفع في الموقع يبيعان بسعر العرض الجاري ما دامت الكمية المخصصة وحد العميل يكفيان، ويحجز placeOrder القطع في دفعته ويعيدها الإلغاء. الناقص: صفحات المنتجات والقوائم والبحث تعرض السعر العادي بعد (يظهر سعر العرض من السلة)، ونقطة البيع تبيع بأسعارها.",
    ),
  },
  "08.04": {
    status: "partial",
    route: "/admin/promotions/points",
    note: n(
      "Earning after delivery and the return window (idempotent; online orders and sales at the till to a known customer, times the VIP multiplier), reversal of later refunds and FIFO expiry (posted every night by the scheduled jobs, or at once from the points page), manual adjustments (a confirm dialog; a second person above 5,000 points or beyond 10,000 points one employee gives alone in 24 hours), the append-only ledger and each customer's balance. A signed-in customer redeems points at the online checkout (the commerce core: up to the balance and the goods left; all given back when the order is cancelled, a share with each refund). Missing: the point of sale does not redeem points.",
      "الكسب بعد التسليم ومدة الإرجاع (دون تكرار؛ طلبات الموقع ومبيعات نقطة البيع لعميل معروف، مع مضاعف العضوية)، واسترجاع النقاط عند استرداد لاحق، والانتهاء بالأقدم أولاً (يرحّلها النظام كل ليلة، أو فوراً من صفحة النقاط)، والتسويات اليدوية (بتأكيد؛ وشخص ثانٍ فوق 5,000 نقطة أو فوق 10,000 نقطة يمنحها موظف وحده خلال 24 ساعة)، ودفتر لا يُعدّل ورصيد كل عميل. يستبدل العميل المسجّل نقاطه عند الدفع في الموقع (نواة التجارة: في حدود رصيده وما بقي من ثمن البضاعة؛ تعود كلها إن أُلغي الطلب، وحصتها مع كل مبلغ يُردّ). الناقص: نقطة البيع لا تستبدل النقاط.",
    ),
  },
  "08.05": {
    status: "partial",
    route: "/admin/promotions/referrals",
    note: n(
      "One code per customer with a cap (a customer sees theirs on the rewards page); refused: self-referral, a number referred twice, a code off or full, an order of someone else; signals for the reviewer: same address, same device, an existing customer, the order's state; the reward (points) after delivery and the return window, never by whoever recorded it. Shoppers type a friend's code at the online checkout: the same rules check it and the referral is recorded for review (a cancelled order gives the use back). Missing: no code at sign-up or at the point of sale — staff record those by hand.",
      "رمز لكل عميل بحد أقصى (يراه العميل في صفحة مكافآته)؛ يُرفض: إحالة النفس، والرقم المحال مرتين، والرمز الموقوف أو الممتلئ، وطلب شخص آخر؛ وإشارات للمراجع: العنوان نفسه، والجهاز نفسه، وعميل سابق، وحالة الطلب؛ والمكافأة نقاط بعد التسليم ومدة الإرجاع ولا يمنحها من سجّلها. يكتب المتسوق رمز صديق عند الدفع في الموقع، فتفحصه القواعد نفسها وتُسجَّل الإحالة للمراجعة (ويعيد الطلب الملغى استخدامها). الناقص: لا يُكتب الرمز عند إنشاء الحساب ولا في نقطة البيع، فيسجّلها الموظفون يدوياً.",
    ),
  },
  "08.06": {
    status: "partial",
    route: "/admin/promotions/vip",
    note: n(
      "Tiers with written benefits and delivery terms, members, and the customers eligible by module 07's own VIP rule; granting and ending with a reason. At the online checkout the commerce core applies the member discount (at most the discount limits in force — 20 % and 50,000 IQD an order by default; a tier above them gets the limit, and its card says so) and free delivery; the points multiplier counts when points are posted, sales at the till included. Missing: early access to sales (written on a tier, read by nothing); no member discount at the point of sale; memberships are not sold.",
      "فئات بمزايا مكتوبة وشروط توصيل، والأعضاء، والعملاء المؤهلون بقاعدة VIP نفسها من القسم 07؛ المنح والإنهاء مع السبب. عند الدفع في الموقع تطبّق نواة التجارة خصم العضوية (حتى حدود الخصم في الإعدادات — 20% و50,000 د.ع للطلب افتراضياً؛ والفئة التي تتجاوزها تأخذ الحد، وتقول بطاقتها ذلك) والتوصيل المجاني؛ ومضاعف النقاط يُحسب عند ترحيلها، ومنها مبيعات نقطة البيع. الناقص: الوصول المبكر للعروض (مكتوب في الفئة ولا يقرؤه شيء)، ولا خصم عضوية في نقطة البيع، والعضويات لا تُباع.",
    ),
  },
  "08.07": {
    status: "partial",
    route: "/admin/promotions/gift-cards",
    note: n(
      "Store-funded cards: issued (code shown once, encrypted like digital codes), a second person above 100,000 IQD or 250,000 IQD a day per employee, revealed only with digital_code.reveal and a reason (audited), voided, expired, redeemed once into a customer's wallet after a confirm dialog with the amount (guarded update + one wallet entry per card, one idempotency key per redemption, a demo card only into a demo account, Dr marketing / Cr wallet liability), and a settlement matched with the wallet ledger. Missing: selling cards for money — the liability account (gift_card_liability, 2150) is in the chart, but there is no sale line at the POS or the checkout.",
      "بطاقات يموّلها المتجر: إصدار (الرمز يظهر مرة ومشفّر كالرموز الرقمية)، وشخص ثانٍ فوق 100,000 د.ع أو 250,000 د.ع يومياً للموظف، وكشف الرمز بصلاحية الكشف وسبب (مسجّل)، وإلغاء وانتهاء، واستخدام مرة واحدة في محفظة العميل بعد تأكيد يعرض المبلغ (تحديث محمي وسطر محفظة واحد لكل بطاقة، ومفتاح عدم تكرار لكل استخدام، والبطاقة التجريبية لحساب تجريبي فقط، مدين تسويق ودائن التزام المحافظ)، وتسوية تُطابق دفتر المحافظ. الناقص: بيع البطاقات بمال — حساب الالتزام موجود في الدليل (2150)، لكن لا سطر بيع في نقطة البيع أو الدفع.",
    ),
  },
  "08.08": {
    status: "partial",
    route: "/admin/promotions/experiments",
    note: n(
      "A/B tests of coupons that start only once the measurement rule is written (metric, minimum orders per variant, planned end); results from real orders per coupon (orders, net revenue, average order, discount per order, refund rate); a winner only when the rule can be read. Missing: the storefront does not assign or count visitors (experiment_assignments / experiment_events), so conversion is not measurable; the point of sale takes no coupon, so its sales are in no test.",
      "تجارب A/B على الكوبونات لا تبدأ إلا بقاعدة قياس مكتوبة (المقياس والحد الأدنى للطلبات لكل نسخة والنهاية)؛ والنتائج من الطلبات الحقيقية لكل كوبون (الطلبات وصافي الإيراد ومتوسط الطلب والخصم لكل طلب ونسبة الاسترداد)؛ ولا فائز قبل بلوغ القاعدة. الناقص: المتجر لا يوزّع الزوار ولا يعدّهم، فالتحويل غير قابل للقياس؛ ونقطة البيع لا تقبل الكوبونات، فلا تدخل مبيعاتها في التجارب.",
    ),
  },

  // ── 09 Suppliers and purchasing (owner: admin purchasing — docs/areas/admin-purchasing.md)
  "09.01": {
    status: "implemented",
    route: "/admin/purchasing/suppliers",
    note: n(
      "Supplier profile: code, legal name, country, the currency it quotes in, payment terms, promised lead time, phone, email, address and contacts (one primary), status with a reason. Quality is the computed rating (09.08) plus staff reviews kept beside it.",
      "ملف المورد: الرمز والاسم القانوني والبلد والعملة التي يسعّر بها وشروط الدفع ومدة التوريد الموعودة والهاتف والبريد والعنوان وجهات الاتصال (واحدة أساسية) والحالة مع السبب. الجودة هي التقييم المحسوب (09.08) ومراجعات الموظفين بجانبه.",
    ),
  },
  "09.02": {
    status: "implemented",
    route: "/admin/purchasing/rfqs",
    note: n(
      "Requests for quotation by SKU; each supplier's quote (unit price, quantity available, lead time, warranty, validity) compared side by side in IQD at the store's rate; the award turns the chosen quote into a draft purchase order. Requests reach suppliers outside the system (no messaging provider) and are marked as sent.",
      "طلبات عروض حسب SKU؛ عرض كل مورد (سعر القطعة والكمية المتوفرة ومدة التوريد والضمان والصلاحية) مقارن جنباً إلى جنب بالدينار بسعر المتجر؛ الترسية تحوّل العرض المختار إلى أمر شراء مسودة. تصل الطلبات إلى الموردين خارج النظام (لا مزود رسائل) وتُعلَّم كمرسلة.",
    ),
  },
  "09.03": {
    status: "partial",
    route: "/admin/purchasing/orders",
    note: n(
      "Drafts, submission, a second person's approval above the spending limit (never whoever created, edited or submitted the order; bound to the request the approver saw), sending, closing, cancelling, printing. The total counts at the higher of the order's rate and the store's rate of the day, with what the same person approved alone for the same supplier in the last 7 days (split orders). The limit is one store-wide constant of 1,000,000 IQD until settings (22) holds the key; per-role limits need approval chains (15.06).",
      "مسودات وإرسال للاعتماد وموافقة شخص ثانٍ فوق حد الإنفاق (ليس من أنشأ الأمر أو عدّله أو أرسله؛ والقرار مربوط بالطلب الذي رآه المعتمِد) وإرسال للمورد وإغلاق وإلغاء وطباعة. يُحسب المجموع بالسعر الأعلى بين سعر الأمر وسعر المتجر لليوم، ومع ما اعتمده الشخص نفسه وحده للمورد نفسه خلال آخر 7 أيام (الأوامر المجزّأة). الحد رقم واحد للمتجر كله (1,000,000 د.ع) ثابت في الكود حتى تضيف الإعدادات (22) مفتاحه؛ حدود لكل دور تحتاج مسارات الموافقة (15.06).",
    ),
  },
  "09.04": {
    status: "implemented",
    route: "/admin/purchasing/receipts",
    note: n(
      "Partial receipts per order line with inspection (refused units and the reason) and one serial per unit, posted into stock through the stock core and into the books (Dr inventory, Cr accounts payable) through the core's posting; supplier invoices matched against the order and the receipts (units, unit prices, and shipping and other charges). Paying invoices and posting price or exchange differences belong to finance (10).",
      "استلام جزئي لكل سطر مع الفحص (القطع المرفوضة وسببها) ورقم تسلسلي لكل قطعة، يُرحّل إلى المخزون عبر نواة المخزون وإلى اليومية (مدين المخزون، دائن ذمم الموردين) عبر ترحيل النواة؛ وفواتير الموردين تُطابَق مع الأمر والاستلامات (الكميات وأسعار القطع ورسوم الشحن والرسوم الأخرى). دفع الفواتير وترحيل فروق السعر والصرف من المالية (10).",
    ),
  },
  "09.05": {
    status: "partial",
    route: "/admin/purchasing/receipts",
    note: n(
      "Freight, customs and other bills are spread over a draft receipt's accepted units by value, quantity or weight through the pricing module's allocation, and posted into the FIFO layers. A bill that arrives after the receipt is posted needs a cost-layer revaluation the commerce core does not have.",
      "فواتير الشحن والجمارك وغيرها توزَّع على القطع المقبولة في استلام مسودة بالقيمة أو الكمية أو الوزن عبر توزيع وحدة التسعير، وتدخل طبقات FIFO. الفاتورة التي تصل بعد ترحيل الاستلام تحتاج إعادة تقييم للطبقات لا تملكها نواة التجارة.",
    ),
  },
  "09.06": {
    status: "partial",
    route: "/admin/purchasing/claims",
    note: n(
      "Claims for shortages, damage, defects, wrong items, prices and returns, from a receipt's refused units or an order's missing ones, through submitted, accepted or rejected, credited and closed; goods go back to the supplier with a reason — units refused at inspection without a stock movement, the others through the stock core, never more than the receipt or order put into stock. Serial-tracked units in stock cannot leave yet (no single-serial core operation) and returns are not posted to the books.",
      "مطالبات النقص والتلف والعيب والصنف الخطأ والسعر والإرجاع، من القطع المرفوضة في استلام أو الناقصة من أمر، مروراً بالإرسال والقبول أو الرفض والإشعار الدائن والإغلاق؛ والبضاعة تعود للمورد مع سبب — المرفوضة عند الفحص دون حركة مخزون، والباقي عبر نواة المخزون، ولا يتجاوز ما أدخله الاستلام أو الأمر إلى المخزون. القطع المتتبعة بالرقم التسلسلي في المخزون لا تخرج بعد (لا عملية لرقم واحد في النواة) والإرجاع لا يُقيَّد في اليومية.",
    ),
  },
  "09.07": {
    status: "implemented",
    route: "/admin/purchasing/alerts",
    note: n(
      "Alerts read from the records: invoices billing more than was received, at another price or with more shipping and other charges than the order agreed (prices only with cost.read), units refused at inspection, lines received beyond the order, orders closed short and late orders, each with its next step; counted on the module's home. The shell's bell does not count them yet.",
      "تنبيهات تُقرأ من السجلات: فواتير تحسب أكثر مما استُلم أو بسعر آخر أو برسوم شحن وأخرى أكثر مما اتُّفق عليه في الأمر (الأسعار لمن يرى التكلفة فقط)، وقطع مرفوضة عند الفحص، واستلام فوق المطلوب، وأوامر أُغلقت ناقصة، وأوامر متأخرة، مع الخطوة التالية لكل منها؛ تُعدّ في صفحة الوحدة. جرس الواجهة لا يعدّها بعد.",
    ),
  },
  "09.08": {
    status: "implemented",
    route: "/admin/purchasing/suppliers",
    note: n(
      "Rating = 60 % on-time units + 40 % (1 − defect rate) over the last 365 days, from posted receipts, late and still-missing units, units that never came on orders closed short after their day, refused units and defect claims; no grade with fewer than 3 posted receipts. Explained on each supplier's page; staff reviews are kept beside it, never mixed in.",
      "التقييم = 60% للقطع التي وصلت في موعدها + 40% × (1 − نسبة العيوب) عن آخر 365 يوماً، من الاستلامات المرحّلة والقطع المتأخرة والناقصة والتي لم تصل أبداً من أوامر أُغلقت ناقصة بعد موعدها والمرفوضة ومطالبات العيب؛ لا درجة بأقل من 3 استلامات مرحّلة. مشروح في صفحة كل مورد؛ ومراجعات الموظفين بجانبه ولا تدخل فيه.",
    ),
  },

  // ── 10 Finance and accounting
  "10.01": {
    status: "implemented",
    route: "/admin/finance/journal",
    note: n(
      "The double-entry journal is the one source of the money: every sale, cost of goods, payment, refund, wallet credit, stock receipt and expense is a balanced entry the database seals. Journal with filters and CSV, each entry with its lines and reference, manual entries (balanced, never on the wallet account, never in a closed month) and reversals of manual entries, chart of accounts with the trial balance and each account's ledger (printable). The books need the cost permission.",
      "دفتر القيد المزدوج هو المصدر الوحيد للمال: كل بيع وتكلفة ودفعة واسترداد ورصيد محفظة واستلام بضاعة ومصروف قيد متوازن تختمه قاعدة البيانات. دفتر بمرشحات وCSV، وكل قيد بأسطره ومرجعه، وقيود يدوية (متوازنة، لا على حساب المحافظ، لا في شهر مغلق) وعكسها، ودليل الحسابات مع ميزان المراجعة ودفتر كل حساب (قابل للطباعة). الدفاتر تحتاج صلاحية التكلفة.",
    ),
  },
  "10.02": {
    status: "partial",
    route: "/admin/finance/settlements",
    note: n(
      "What each method owes and has settled (cash on delivery, card and Zain Cash transfers, wallet), statement CSV import (Arabic or English headers, re-import adds nothing), matching lines to paid payments (exact bulk match, a note for a difference), undo and set aside. Missing: carriers' cash settlements are recorded by shipping (11.04) and only shown here; a wallet top-up transfer can only be set aside with a note (statement lines link to order payments only); no online card gateway is configured.",
      "ما تنتظره كل طريقة دفع وما سُوّي (الدفع عند الاستلام، تحويلات البطاقة وزين كاش، المحفظة)، واستيراد كشف CSV (عناوين عربية أو إنجليزية، وإعادة الاستيراد لا تضيف شيئاً)، ومطابقة السطور بالدفعات المدفوعة (مطابقة جماعية للمؤكد، وملاحظة للفرق)، والإلغاء والاستبعاد. ينقص: تسويات شركات الشحن تُسجَّل في قسم الشحن (11.04) وتُعرض هنا فقط، وحوالة شحن المحفظة تُستبعد بملاحظة لأن السطور ترتبط بدفعات الطلبات فقط، ولا بوابة دفع بالبطاقة مُعدّة.",
    ),
  },
  "10.03": {
    status: "implemented",
    route: "/admin/finance/revenue",
    note: n(
      "Revenue recognised at delivery, read from the journal, against the orders still open now (paid in advance or still to collect), delivered orders whose cash is not recorded yet, and the customer control balance.",
      "الإيراد المحقق عند التسليم من الدفاتر، مقابل الطلبات المفتوحة الآن (مدفوعة مقدماً أو لم تُحصَّل)، والطلبات المسلّمة التي لم يُسجَّل نقدها، ورصيد ذمم العملاء.",
    ),
  },
  "10.04": {
    status: "implemented",
    route: "/admin/finance/revenue",
    note: n(
      "Cost of goods at FIFO landed cost (cost permission), discounts with the coupons behind them, refunds by method and those awaiting approval, goods back in stock or written off, gross margin (profit permission).",
      "تكلفة البضاعة بالتكلفة الواصلة (صلاحية التكلفة)، والخصومات مع الكوبونات التي وراءها، والاستردادات حسب الطريقة والمعلقة، والبضاعة العائدة إلى المخزون أو المشطوبة، وهامش مجمل الربح (صلاحية الربح).",
    ),
  },
  "10.05": {
    status: "implemented",
    route: "/admin/finance/expenses",
    note: n(
      "Operating, payroll, shipping and marketing expenses (and the accountant's own expense accounts) with cost centres and a private receipt photo. A draft enters the books only when approved — one entry through the accounting core, never twice; above 500,000 IQD someone other than whoever recorded it approves, and what one person records and approves alone counts together over 24 hours (no splitting); voiding a posted expense reverses it. The limit is a constant until settings hold it; payroll runs are module 15's.",
      "مصروفات التشغيل والرواتب والشحن والتسويق (وحسابات المحاسب الخاصة) بمراكز تكلفة وصورة إيصال خاصة. المسودة لا تدخل الدفاتر إلا عند اعتمادها، بقيد واحد عبر نواة المحاسبة لا يتكرر؛ فوق 500,000 د.ع يعتمدها غير من سجّلها، وما يسجّله الشخص ويعتمده وحده يُجمع خلال 24 ساعة (لا تجزئة)؛ وإلغاء المرحّل يكون بقيد عكسي. الحد ثابت حتى تحمله الإعدادات؛ مسير الرواتب للقسم 15.",
    ),
  },
  "10.06": {
    status: "implemented",
    route: "/admin/finance/reports",
    note: n(
      "Profit and loss exactly as docs/metrics.md defines it (cost lines only with the cost permission, profit lines with the profit permission too), cash flow by cause, inventory account against the stock it stands for with the differences explained; printable, CSV.",
      "الأرباح والخسائر كما يعرّفها قاموس المقاييس (بنود التكلفة بصلاحية التكلفة، وبنود الربح بصلاحية الربح أيضاً)، والتدفق النقدي حسب السبب، وحساب المخزون مقابل المخزون الفعلي مع تفسير الفروق؛ قابل للطباعة وCSV.",
    ),
  },
  "10.07": {
    status: "implemented",
    route: "/admin/finance/wallets",
    note: n(
      "The wallet is its ledger (no balance anyone can edit), shown read-only and checked against its account to the dinar. Top-up requests are decided here with the private proof: creditWallet once (\"topup:<id>\"), two people above 500,000 IQD (what one person approved alone for the customer in 24 hours counts with it), a reason the customer reads when rejected. Adjustments are requested by one employee and approved by another. Adjustments only credit: the core has no debit adjustment.",
      "المحفظة هي دفترها (لا رصيد يُعدَّل)، تُعرض للقراءة فقط وتُطابَق مع حسابها بالدينار. طلبات الشحن تُقرر هنا مع الإثبات الخاص: إضافة واحدة عبر creditWallet، وشخصان فوق 500,000 د.ع (ويُحسب معه ما اعتمده الشخص وحده للعميل خلال 24 ساعة)، وسبب يقرؤه العميل عند الرفض. التسويات يطلبها موظف ويوافق عليها آخر. التسويات إضافة فقط: النواة لا تخصم بتسوية.",
    ),
  },
  "10.08": {
    status: "partial",
    route: "/admin/finance/tax",
    note: n(
      "Editable tax configuration (rate, product kinds, channels, start date, with a reason) and a report of the tax included in delivered sales per active rate. No rate is configured: which taxes apply to the store in Iraq is the owner's decision with their accountant. Missing: checkout adds no tax and the chart has no tax-liability account, so a rate is reported, never collected or posted.",
      "إعداد ضريبة قابل للتعديل (النسبة وأنواع المنتجات والقنوات وتاريخ البدء مع السبب) وتقرير الضريبة المشمولة في المبيعات المسلّمة لكل نسبة مفعّلة. لا نسبة مُعدّة: ما ينطبق على المتجر في العراق قرار المالك ومحاسبه. ينقص: الدفع لا يضيف ضريبة ولا حساب التزام ضريبي في الدليل، فالنسبة تُعرض في التقرير ولا تُحصَّل ولا تُرحَّل.",
    ),
  },
  "10.09": {
    status: "implemented",
    route: "/admin/finance/close",
    note: n(
      "Monthly close with a checklist (the month is over, earlier months closed, entries balanced; warnings for draft expenses, waiting proofs, refunds and top-ups, unmatched statement lines, critical findings) and a reason; the database refuses every entry dated in a closed month and the services anything dated before the last closed month, so a closed month changes only through reversing or adjusting entries in an open month after it. No reopening.",
      "إغلاق شهري بقائمة تحقق (انتهى الشهر، أُغلقت الأشهر السابقة، القيود متوازنة؛ وتنبيهات للمسودات والحوالات والاستردادات والشحن المعلق وسطور الكشوف غير المطابقة والتحذيرات الحرجة) وبسبب؛ وقاعدة البيانات ترفض أي قيد بتاريخ في شهر مغلق، والخدمات ترفض أي تاريخ قبل آخر شهر مغلق، فلا يتغير الشهر المغلق إلا بقيد عكسي أو تسوية في شهر مفتوح بعده. لا إعادة فتح.",
    ),
  },
  "10.10": {
    status: "implemented",
    route: "/admin/finance/anomalies",
    note: n(
      "Deterministic checks run when the page opens — money that is not a whole number, accounts on their unusual side, the trial balance, wallets against their account, orders against their lines and payments, money without its posting, statement matches with a different amount, approved top-ups or adjustments not credited, expenses without their entry — next to the daily consistency job's findings.",
      "فحوصات ثابتة تعمل عند فتح الصفحة: مبالغ ليست أعداداً صحيحة، وحسابات على غير جهتها، وميزان المراجعة، والمحافظ مقابل حسابها، والطلبات مقابل أسطرها ودفعاتها، ومال بلا قيد، ومطابقات بمبلغ مختلف، وشحن أو تسويات معتمدة لم تُضف، ومصروفات بلا قيد؛ بجانب نتائج الفحص اليومي.",
    ),
  },

  // ── 11 Shipping and delivery
  "11.01": {
    status: "implemented",
    route: "/admin/shipping/zones",
    note: n(
      "Governorates paused or offered, districts added, renamed (the id stays) or switched off, the flat fee and per-governorate fees with the governorates whose fee changes shown before confirming (reason, audit), delivery estimates in days. The storefront does not show the estimate yet (checkout's choice); it is never a promise.",
      "إيقاف المحافظات أو إتاحتها، إضافة الأقضية وتغيير أسمائها (يبقى المعرّف) أو إيقافها، الرسم الموحّد والرسوم الخاصة مع عرض المحافظات التي يتغيّر رسمها قبل التأكيد (سبب وتدقيق)، والمدد التقديرية بالأيام. المتجر لا يعرض المدة بعد (قرار صفحة الدفع)، وهي ليست وعداً.",
    ),
  },
  "11.02": {
    status: "implemented",
    route: "/admin/shipping/carriers",
    note: n(
      "Carriers and the store's drivers with their rate and estimate per governorate and service level, cash collection and its fee; on a parcel they are ranked by cost (rate + cash fee), and a rule gives the cheapest eligible one to many parcels. No courier API is connected: booking is by phone or the carrier's portal.",
      "شركات الشحن وسائقو المتجر بسعر ومدة لكل محافظة ومستوى خدمة، والتحصيل وعمولته؛ في صفحة الطرد تُرتَّب بالكلفة (السعر + عمولة التحصيل)، وقاعدة تعطي الأرخص المؤهل لعدة طرود. لا ربط برمجي مع الشركات: الحجز بالهاتف أو من بوابة الشركة.",
    ),
  },
  "11.03": {
    status: "implemented",
    route: "/admin/shipping/shipments",
    note: n(
      "Waybill on the orders module's parcels (carrier, level, the carrier's tracking number or the waybill number REF-n, cost, cash to collect), printed waybills with Code 128 and pickup manifests, pickup that ships the order through the orders module's rules, courier statuses and scan lookup. Statuses are typed or scanned by staff: no courier API sends them.",
      "بوليصة على طرود قسم الطلبات (الشركة والمستوى ورقم تتبع الشركة أو رقم البوليصة والكلفة والنقد المطلوب)، بوالص مطبوعة بباركود Code 128 وقوائم استلام، تسليم للمندوب يشحن الطلب بقواعد قسم الطلبات، حالات الشركة والبحث بالمسح. الحالات يدخلها الموظفون: لا ربط برمجي يرسلها.",
    ),
  },
  "11.04": {
    status: "implemented",
    route: "/admin/shipping/cod",
    note: n(
      "Drafts from the carrier's statement (cash per delivered parcel, the carrier's charge), the amount remitted, the difference; reconciling records each parcel's cash through recordCodCollection and posts the settlement (cash/bank, shipping costs, cash over/short). A difference — or a parcel's cash or charge corrected by hand (with a reason) — is reconciled by a second person who did not create, correct or submit it. Courier-held cash sits in the cash account until then (no separate account in the chart).",
      "مسودات من كشف الشركة (النقد لكل طرد مُسلّم وعمولة الشركة)، والمبلغ المسلَّم والفرق؛ المطابقة تسجّل تحصيل كل طرد عبر recordCodCollection وتقيّد التسوية (الصندوق/المصرف، تكاليف الشحن، عجز وزيادة الصندوق). الفرق — أو نقد طرد أو عمولته المصحّحة يدوياً (بسبب) — يطابقه شخص ثانٍ لم ينشئها ولم يصحّحها ولم يرسلها. النقد لدى المندوبين يبقى في حساب الصندوق حتى ذلك (لا حساب منفصل في الدليل).",
    ),
  },
  "11.05": {
    status: "partial",
    route: "/admin/shipping/attempts",
    note: n(
      "Failed tries with outcome, reason and next day, retries, sending back, and receiving parcels back: the order is returned through the core (goods restocked or written off, unpaid cash cancelled, paid money to a two-person refund). Missing: an order whose parcels split — one delivered, another back — cannot be closed here (the core has no partial return of a shipped order).",
      "المحاولات الفاشلة بالنتيجة والسبب وموعد المحاولة القادمة، وإعادة المحاولة، والإرجاع، واستلام الطرود الراجعة: يُرجَع الطلب عبر النواة (البضاعة إلى المخزون أو تُشطب، يُلغى النقد غير المحصّل، والمدفوع إلى استرداد بشخصين). الناقص: طلب انقسمت طروده — طرد سُلّم وآخر رجع — لا يُغلق هنا (النواة لا ترجع جزءاً من طلب مشحون).",
    ),
  },
  "11.06": {
    status: "implemented",
    route: "/admin/shipping/shipments",
    note: n(
      "A parcel with a console, a serial-tracked unit or a used device needs a private packing photo before this module hands it to the courier, and the receiver's name at delivery; the signed waybill's photo is the proof of receipt (private files). The orders module's own paths do not check them yet (requested): its packing-station handover ships without the packing photo, and its \"delivered\" step delivers without the receiver's name.",
      "الطرد الذي فيه جهاز ألعاب أو قطعة برقم تسلسلي أو جهاز مستعمل يحتاج صورة تغليف خاصة قبل أن يسلّمه هذا القسم للمندوب، واسم المستلم عند التسليم؛ وصورة البوليصة الموقّعة هي إثبات الاستلام (ملفات خاصة). مسارات قسم الطلبات لا تتحقق منهما بعد (مطلوب): تسليمه من محطة التغليف يشحن بلا صورة التغليف، وخطوة «سُلّم» فيه تسلّم بلا اسم المستلم.",
    ),
  },

  // ── 12 Returns and warranty
  "12.01": {
    status: "implemented",
    route: "/admin/returns/new",
    note: n(
      "Staff open an RMA on the customer's behalf from the order: units by serial, reason, private photos, a return slip with a barcode. Customers cannot open one from their account yet (the account page sends them to support).",
      "يفتح الموظف طلب الإرجاع نيابة عن العميل من رقم الطلب: القطع بأرقامها التسلسلية والسبب وصور خاصة وورقة إرجاع بباركود. لا يستطيع العميل فتحه من حسابه بعد (صفحة الحساب ترسله إلى الدعم).",
    ),
  },
  "12.02": {
    status: "implemented",
    route: "/admin/returns/policies",
    note: n(
      "Rules by product kind, category, new or used: window, seal for change-of-mind returns, restocking fee; checked for every unit before an RMA opens (outside the rules only with a manager's reason). The general window is a setting.",
      "قواعد حسب نوع المنتج وفئته وكونه جديداً أو مستعملاً: المدة والختم عند تغيير الرأي ورسوم إعادة التخزين، وتُفحص لكل قطعة قبل فتح الطلب (والاستثناء بسبب يكتبه مدير). المدة العامة إعداد.",
    ),
  },
  "12.03": {
    status: "implemented",
    route: "/admin/returns",
    note: n(
      "Each unit is graded (sellable, opened, defective, damaged) after its serial is scanned; it goes back on sale, into quarantine or is written off through the commerce core, and its serial link is released.",
      "تُصنف كل قطعة (صالحة، مفتوحة، معيبة، تالفة) بعد مسح رقمها التسلسلي، وتعود إلى البيع أو العزل أو تُشطب عبر نواة التجارة، ويُحرر ربط رقمها بالطلب.",
    ),
  },
  "12.04": {
    status: "implemented",
    route: "/admin/returns",
    note: n(
      "Refunds of the units that came back (a unit kept by the customer only after its repair failed) to the original method, the customer's wallet (store credit) or cash, only through createRefund and a second person's approval; never above what is refundable, nor above the units' value minus the policy's restocking fee on a change of mind.",
      "استرداد القطع التي رجعت (والقطعة التي بقيت مع العميل فقط إذا تعذر إصلاحها) إلى الوسيلة الأصلية أو محفظة العميل (رصيد) أو نقداً، عبر نواة التجارة وبموافقة شخص ثانٍ فقط؛ ولا يتجاوز القابل للاسترداد ولا قيمة القطع بعد رسوم إعادة التخزين التي تحددها القواعد عند تغيير الرأي.",
    ),
  },
  "12.05": {
    status: "implemented",
    route: "/admin/returns?view=flagged",
    note: n(
      "A unit is in one return at a time and refunded once — also when two requests race for it (a guard inside the refund's own transaction), besides the return's, the core's and the database's checks; nine fraud rules are explained on every RMA.",
      "القطعة في طلب إرجاع واحد في كل مرة وتُسترد مرة واحدة — حتى لو تسابق طلبان عليها (حارس داخل معاملة الاسترداد نفسها) — إضافة إلى فحص الطلب والنواة وقاعدة البيانات، وتسع قواعد احتيال مشروحة على كل طلب.",
    ),
  },
  "12.06": {
    status: "boundary",
    route: "/admin/returns/warranties",
    note: n(
      "Built: dates, the maker's warranty shown apart, service history, replaced parts, extend and void with a reason. New products get a store warranty only once the owner sets the store's terms (products.warranty_months is empty, STATUS item 15); used devices carry theirs.",
      "مبني: التواريخ وضمان الشركة المصنعة منفصلاً وتاريخ الصيانة والقطع المستبدلة والتمديد والإلغاء بسبب. لا يبدأ ضمان المتجر للمنتجات الجديدة حتى يحدد المالك شروطه (مدة الضمان فارغة)؛ الأجهزة المستعملة تحمل ضمانها.",
    ),
  },
  "12.07": {
    status: "partial",
    route: "/admin/returns/repairs",
    note: n(
      "Repairs with SLA timers, quotes and parts; quarantine to refurbish or return to the supplier (a return claim). Missing: a replacement is store credit plus a new order (no free replacement shipment in the core), repair charges are not collected here, parts are not taken out of stock from the ticket, SLA targets are fixed in the module.",
      "صيانة بمهل زمنية وأسعار وقطع، وعزل للتجديد أو للإرجاع إلى المورد (مطالبة إرجاع). الناقص: الاستبدال رصيد ثم طلب جديد (لا شحنة بديلة مجانية في النواة)، ولا يُحصّل ثمن الصيانة هنا، ولا تخرج القطع من المخزون من التذكرة، ومُهل الخدمة ثابتة في القسم.",
    ),
  },

  // ── 13 Devices, games and trade-in
  "13.01": {
    status: "implemented",
    route: "/admin/devices/registry",
    note: n(
      "Every serial-numbered unit by serial, condition (new, or used with its grade) and source (the supplier's receipt and purchase order, the trade-in, the demo opening stock), with its status, location, the order holding it, trade-ins, warranties and — for the movement log's permission — its movements; cost only with cost.read. A serial is sold once (database rule); a unit the store sold before and buys back is released from its old sale.",
      "كل جهاز برقمه التسلسلي وحالته (جديد، أو مستعمل بدرجته) ومصدره (فاتورة المورد وأمر الشراء، أو المقايضة، أو الرصيد الافتتاحي التجريبي)، مع وضعه ومكانه والطلب الذي يحمله والمقايضات والضمانات وحركاته لمن يملك صلاحية سجل الحركات؛ التكلفة لمن يملك صلاحية التكلفة فقط. الرقم التسلسلي يُباع مرة واحدة، والجهاز الذي باعه المتجر ثم اشتراه يتحرر من بيعه القديم.",
    ),
  },
  "13.02": {
    status: "implemented",
    route: "/admin/devices/templates",
    note: n(
      "A checklist per kind (console, handheld PC, controller, headset, other, used game) with required and critical items — screen, battery (%), ports, buttons, heat; each save is a new version so filled checklists keep their words. Filled at the trade-in inspection and on each used unit; a failed critical item keeps the unit off sale.",
      "قائمة فحص لكل نوع (جهاز منزلي، محمول، يد تحكم، سماعة، آخر، لعبة مستعملة) ببنود مطلوبة وحاسمة — الشاشة والبطارية (٪) والمنافذ والأزرار والحرارة؛ كل حفظ نسخة جديدة فتبقى القوائم المملوءة على كلماتها. تُملأ عند فحص المقايضة وعلى كل جهاز مستعمل، والبند الحاسم الفاشل يمنع العرض للبيع.",
    ),
  },
  "13.03": {
    status: "implemented",
    route: "/admin/devices/guides",
    note: n(
      "Price guides per model (or one variant): the reference market price of a grade-A+ unit, each grade's share and a deduction per missing accessory, audited before/after. The trade-in page shows the guide's suggestion for the inspected grade and accessories, beside the store's own new and used prices. No external market-price feed is connected: the reference price is what staff enter.",
      "أدلة أسعار لكل طراز (أو خيار): سعر السوق المرجعي لجهاز A+ وحصة كل درجة وخصم كل ملحق ناقص، مع تدقيق القيم قبل وبعد. تعرض صفحة المقايضة اقتراح الدليل للدرجة والملحقات المفحوصة بجانب أسعار المتجر للجديد والمستعمل. لا مصدر خارجي لأسعار السوق متصل: السعر المرجعي يدخله الموظفون.",
    ),
  },
  "13.04": {
    status: "partial",
    route: "/admin/devices/trade-ins",
    note: n(
      "Final offer made by a person after the inspection, open 1–30 days (expired or declined offers replaced, the history keeps both); the price difference against any SKU or used unit; payout as store credit in the wallet or cash, with a printable offer the customer signs. Missing: the trade-in value cannot pay part of a purchase in one transaction (checkout pays a whole order from the wallet only; the POS does not take trade-ins), and the job that marks expired offers is not scheduled yet.",
      "عرض نهائي يصدره موظف بعد الفحص، صالح من يوم إلى 30 يوماً (يُستبدل المنتهي أو المرفوض ويبقى كلاهما في السجل)، وفرق السعر عن أي منتج أو جهاز مستعمل، والدفع رصيداً في المحفظة أو نقداً مع عرض مطبوع يوقعه العميل. الناقص: قيمة المقايضة لا تدفع جزءاً من مشتريات في عملية واحدة (الدفع بالمحفظة يغطي طلباً كاملاً فقط ونقطة البيع لا تأخذ المقايضة)، ومهمة إنهاء العروض المنتهية غير مجدولة بعد.",
    ),
  },
  "13.05": {
    status: "implemented",
    route: "/admin/devices/used",
    note: n(
      "A used game is taken in at the counter by its SKU or barcode and inspected on the games checklist (disc or cartridge surface, case and cover, region and platform, unused codes); its unit page shows the catalogue's region, platform, copy format and compatibility rules.",
      "تُستلم اللعبة المستعملة في المحل برمز SKU أو الباركود وتُفحص بقائمة الألعاب (سطح القرص أو البطاقة، العلبة والغلاف، المنطقة والمنصة، رموز غير مستخدمة)، وتعرض صفحتها منطقة الكتالوج ومنصته ونوع النسخة وقواعد التوافق.",
    ),
  },
  "13.06": {
    status: "implemented",
    route: "/admin/devices/digital",
    note: n(
      "Every game and digital product in one delivery class from the catalogue's facts (disc, cartridge, code, add-on, subscription, wallet top-up, account), with the products whose facts disagree linked to the catalogue editor where they are fixed, and the code stock per digital option.",
      "كل لعبة ومنتج رقمي بطريقة تسليم واحدة من حقائق الكتالوج (قرص، بطاقة، رمز، محتوى إضافي، اشتراك، شحن رصيد، حساب)، مع المنتجات المتعارضة الحقائق وروابطها إلى محرر الكتالوج حيث تُصحح، ومخزون الرموز لكل خيار رقمي.",
    ),
  },
  "13.07": {
    status: "partial",
    route: "/admin/devices/digital",
    note: n(
      "Codes are imported encrypted (AES-256-GCM with DATA_KEY, bound to their row), never stored twice, never shown in a list; staff reveal a code only once it was delivered on a paid order line (never unsold stock, never an unpaid or refunded line), with digital_code.reveal and a reason, audited and rate-limited; revoke. Missing: giving a code to its buyer after payment (the commerce core does not assign codes to paid order lines yet, and the order page cannot show one) — so no code is revealable yet.",
      "تُضاف الرموز مشفرة (AES-256-GCM بمفتاح البيانات، مربوطة بصفها) ولا تُخزن مرتين ولا تظهر في أي قائمة؛ لا يكشف الموظف رمزاً إلا بعد تسليمه على سطر طلب مدفوع (لا رمز غير مبيع ولا سطر غير مدفوع أو مسترد)، بصلاحية الكشف وسبب، ويُسجل الكشف ويُحد؛ والإلغاء. الناقص: تسليم الرمز لمشتريه بعد الدفع (نواة التجارة لا تخصص الرموز لسطور الطلبات المدفوعة بعد، وصفحة الطلب لا تعرضها) — لذلك لا رمز قابل للكشف بعد.",
    ),
  },
  "13.08": {
    status: "implemented",
    route: "/admin/devices/trade-ins",
    note: n(
      "At the inspection: proof of ownership and the account-lock check, confirmed by staff who may verify ownership (no offer without both; a confirmation holds for that serial only); after acceptance: accounts unlinked and data wiped, confirmed before the payout; on used units: ownership and wipe confirmations, the wipe again after a return. A unit is never listed without both (service and database rule).",
      "عند الفحص: إثبات الملكية وفحص قفل الحسابات، يؤكدهما موظف يملك صلاحية التحقق من الملكية (لا عرض دونهما، والتأكيد يخص ذلك الرقم التسلسلي وحده)؛ بعد القبول: فصل الحسابات ومسح البيانات وتأكيدهما قبل الدفع؛ وعلى الأجهزة المستعملة: تأكيد الملكية والمسح، والمسح من جديد بعد الإرجاع. لا يُعرض جهاز دونهما (قاعدة في الخدمة وقاعدة البيانات).",
    ),
  },
  "13.09": {
    status: "partial",
    route: "/admin/devices/used",
    note: n(
      "Grades A+…C with condition words, disclosed defects, what is included and the store warranty; photos stay private until a person confirms they show this very unit and are published when it is listed (the store labels everything else as an illustration); the customer approves the offer made on the documented grade — in person on the signed printout, or online. Missing: the storefront's tracking page shows the online customer the offer but not the grade and checklist it was made on.",
      "درجات من A+ إلى C مع وصف الحالة والعيوب الظاهرة وما يأتي مع الجهاز وضمان المتجر؛ تبقى الصور خاصة حتى يؤكد موظف أنها صور الجهاز نفسه وتُنشر عند عرضه للبيع (ويصف المتجر غيرها بأنها توضيحية)؛ ويوافق العميل على العرض المبني على الدرجة الموثقة — حضورياً بتوقيع العرض المطبوع أو عبر الموقع. الناقص: صفحة المتابعة في المتجر تعرض للعميل العرض دون الدرجة وقائمة الفحص التي بُني عليها.",
    ),
  },

  // ── 14 Customer service
  "14.01": {
    status: "boundary",
    route: "/admin/support",
    note: n(
      "One inbox for the site's tickets, the maintenance assistant's hand-offs and repair requests: saved views (needs a reply, mine, nobody holds, late, escalated to me…), filters, sort and page in the URL, bulk assign and route. No e-mail, WhatsApp or chat provider is connected: staff open a ticket for a call, a message or a visit and type in what the customer said; a written reply is held in the outbox (never sent) and the customer reads it on their ticket page.",
      "صندوق وارد واحد لتذاكر الموقع وتحويلات مساعد الصيانة وطلبات الصيانة: عروض محفوظة (تحتاج رداً، تذاكري، بلا موظف، متأخرة، مصعّدة إليّ…) ومرشحات وترتيب وصفحات في الرابط، وتوزيع وتوجيه جماعي. لا يوجد مزود بريد أو واتساب أو محادثة متصل: يفتح الموظف تذكرة للمكالمة أو الرسالة أو الزيارة ويسجل ما قاله الزبون، والرد المكتوب يُحفظ في الرسائل المعلقة ولا يُرسل، ويراه الزبون في صفحة تذكرته.",
    ),
  },
  "14.02": {
    status: "implemented",
    route: "/admin/support",
    note: n(
      "Each ticket links the customer (module 07's profile), the order, the product, the warranty, the repair and the return by their ids, refuses a link of another customer or order, suggests the account with the ticket's phone, and shows each record only to staff who may open it. Replies, internal notes, status with reasons, priority and topic with their due times, who holds it and why; the ticket prints as its record.",
      "كل تذكرة تربط الزبون (ملفه في القسم 07) والطلب والمنتج والضمان والصيانة والإرجاع بأرقامها، وترفض ربط سجل لزبون أو طلب آخر، وتقترح الحساب برقم موبايل التذكرة، ولا تعرض السجل إلا لمن يحق له فتحه. ردود وملاحظات داخلية وحالة مع السبب وأولوية وموضوع مع مواعيدهما ومن يمسكها ولماذا، وتُطبع كسجل.",
    ),
  },
  "14.03": {
    status: "partial",
    route: "/admin/support/routing",
    note: n(
      "Rules by topic, channel, keywords and priority, in order, with an agent pool and a capacity per agent (checked again inside the write), a team queue and a priority; the reason each ticket went where it went is recorded and shown; a dry run on the open tickets; every agent's load. Missing: tickets the site opens are routed when an assigner routes the waiting ones (one key) — automatic routing on arrival waits for the scheduled job (requested).",
      "قواعد حسب الموضوع والقناة والكلمات والأولوية بالترتيب، مع مجموعة موظفين وحد لكل موظف (يُتحقق منه داخل الكتابة نفسها) وقائمة فريق وأولوية؛ يُسجّل سبب ذهاب كل تذكرة ويُعرض؛ تجربة على التذاكر المفتوحة؛ وعدد تذاكر كل موظف. الناقص: تذاكر الموقع تُوزّع عندما يوزّع موظف التذاكر المنتظرة بزر واحد، والتوزيع التلقائي عند وصولها ينتظر المهمة المجدولة (طُلبت).",
    ),
  },
  "14.04": {
    status: "implemented",
    route: "/admin/support/replies",
    note: n(
      "Canned replies in Arabic, English and Sorani with ten safe variables filled from the ticket on the server ({customer_name}, {order_ref}, {order_status}…); any other brace, condition or markup is refused. On a ticket a canned reply only fills the composer in the customer's language; the agent edits it, and a text that still holds a variable is not recorded. Sending is 14.01's boundary.",
      "ردود جاهزة بالعربية والإنجليزية والسورانية مع عشرة متغيرات آمنة تُملأ من التذكرة على الخادم ({customer_name} و{order_ref} و{order_status}…)، ويُرفض أي قوس آخر أو شرط أو وسم. في التذكرة يملأ الرد الجاهز خانة الكتابة بلغة الزبون فقط، ويعدّله الموظف، ولا يُسجّل نص بقي فيه متغير. الإرسال حدّه في 14.01.",
    ),
  },
  "14.05": {
    status: "partial",
    route: "/admin/support/metrics",
    note: n(
      "First-response and resolution times (median, 90%, share on time) from the tickets' own events, by agent, topic, priority and channel, the backlog and repairs; SLA policies per priority and topic give tickets their due times (the site's too) and fill open tickets that have none. Missing: customer satisfaction is shown as not collected — the store sends no survey (no messaging provider) and the site has no rating page.",
      "زمن أول رد وزمن الحل (الوسيط و90٪ ونسبة الالتزام بالموعد) من أحداث التذاكر نفسها، حسب الموظف والموضوع والأولوية والقناة، والتذاكر المفتوحة والصيانة؛ وأهداف خدمة لكل أولوية وموضوع تعطي التذاكر مواعيدها (تذاكر الموقع أيضاً) وتملأ المفتوحة بلا مواعيد. الناقص: رضا العملاء يظهر «غير مُجمّع» لأن المتجر لا يرسل استبياناً (لا مزود رسائل) ولا توجد صفحة تقييم في الموقع.",
    ),
  },
  "14.06": {
    status: "implemented",
    route: "/admin/support/knowledge",
    note: n(
      "Internal articles for staff and the help centre's public guides, written as lines that become safe blocks (catalogue photos checked), previewed as the site renders them, published through review: someone who did not write a version approves it; an approved article's edit waits as a revision while the site keeps the approved text; archive and restore. The site shows approved public articles only.",
      "مقالات داخلية للموظفين وأدلة مركز المساعدة للعملاء، تُكتب سطوراً تصبح أجزاء آمنة (صور الكتالوج يُتحقق منها)، وتُعاين كما يعرضها الموقع، وتُنشر بالمراجعة: يعتمد النسخة شخص لم يكتبها، وتعديل المقال المعتمد ينتظر مراجعة والموقع يعرض النص المعتمد حتى ذلك؛ أرشفة واسترجاع. الموقع يعرض المقالات المعتمدة العامة فقط.",
    ),
  },
  "14.07": {
    status: "implemented",
    route: "/admin/support?view=escalated_me",
    note: n(
      "A financial complaint goes to someone who approves refunds, a warranty complaint to someone who manages warranties — never the person escalating — with the reason; priority rises to high and only that person resolves or closes it until they hand it back with the decision. Nothing is paid here: refunds and returns happen in Orders (05) and Returns (12), linked from the ticket. Only holders who can also open tickets are offered (the finance role cannot until it is granted ticket reading).",
      "الشكوى المالية تذهب لمن يعتمد الاستردادات وشكوى الضمان لمن يدير الضمانات، وليس لمن يصعّدها، مع السبب؛ ترتفع الأولوية إلى عالية ولا يحلّها أو يغلقها غيره حتى يعيدها مع القرار. لا يُدفع شيء هنا: الاسترداد والإرجاع في الطلبات (05) والمرتجعات (12) بروابط من التذكرة. لا يُعرض إلا من يستطيع فتح التذاكر أيضاً (دور المالية لا يستطيع حتى تُمنح له قراءة التذاكر).",
    ),
  },

  // ── 15 Staff and HR
  "15.01": {
    status: "implemented",
    route: "/admin/staff/employees",
    note: n(
      "The directory, and each employee's effective permissions read-only (by module, protected-data ones marked, with the role that grants each); roles are edited in one place, /admin/security/roles (module 20). Adding an employee (staff.manage): the roles this person holds all of, the branch, a reason; the account has no password until the employee sets one with a one-time link shown once to whoever made it (no message provider: handed over in person). From the employee's file: a new link, and re-enabling a closed account.",
      "دليل الموظفين، وصلاحيات كل موظف الفعلية للعرض فقط (حسب القسم، مع تمييز البيانات المحمية والدور الذي يمنح كلاً منها)؛ والأدوار تُعدَّل في مكان واحد: /admin/security/roles (القسم 20). إضافة موظف (صلاحية إدارة الموظفين): الأدوار التي يملك المضيف كل صلاحياتها، والفرع، وسبب؛ ولا كلمة مرور للحساب حتى يضعها الموظف برابط يظهر مرة واحدة لمن صنعه (لا مزوّد رسائل: يُسلَّم باليد). ومن ملف الموظف: رابط جديد، وإعادة تفعيل حساب موقوف.",
    ),
  },
  "15.02": {
    status: "partial",
    route: "/admin/staff/schedule",
    note: n(
      "Week roster of work shifts (no overlaps, none on approved leave, a week copied), clock-in and out on My day with lateness, manual entries and corrections with a reason, bulk approval (never one's own), leave requests decided by someone else (approval cancels that day's shifts), tasks. POS cash-drawer shifts stay module 06's. Missing: an employee with no staff permission (a cashier) cannot open My day until the admin gate opens /admin/staff/me to every employee (requested).",
      "جدول أسبوعي لورديات الدوام (بلا تداخل، ولا في إجازة معتمدة، ونسخ أسبوع)، وتسجيل الحضور والانصراف في «يومي» مع التأخير، وتسجيل يدوي وتصحيح بسبب، واعتماد جماعي (لا لسجل الشخص نفسه)، وإجازات يقررها غير صاحبها (والاعتماد يلغي ورديات تلك الأيام)، ومهام. ورديات أدراج نقطة البيع تبقى للقسم 06. ناقص: موظف بلا صلاحية في هذا القسم (الكاشير) لا يفتح «يومي» حتى تفتح بوابة الإدارة /admin/staff/me لكل موظف (طُلب).",
    ),
  },
  "15.03": {
    status: "implemented",
    route: "/admin/staff/commissions",
    note: n(
      "Versioned plans (a change is a new version; past sales keep the version in force when delivered) on sales or realised profit — a profit plan and its bases only with profit.read — for an employee, a role or everyone; paid on delivered counter sales net of discounts and returns, a return landing later becomes a clawback at the next computation (staff or the payroll run start it; a daily job is requested).",
      "خطط بنسخ (التغيير نسخة جديدة، وما بيع سابقاً يبقى بنسخته السارية عند التسليم) على المبيعات أو الربح المحقق — وخطة الربح وأسسها بصلاحية رؤية الربح فقط — لموظف أو دور أو للجميع؛ تُحسب على مبيعات الصندوق المسلّمة بعد الخصومات والمرتجعات، والمرتجع اللاحق يصبح خصماً في الحساب التالي (يبدؤه الموظف أو مسير الرواتب؛ والمهمة اليومية مطلوبة).",
    ),
  },
  "15.04": {
    status: "partial",
    route: "/admin/staff/payroll",
    note: n(
      "Monthly runs: base pro-rated by days employed and unpaid leave, commissions, bonuses and deductions with a note, salary advances; prepared by one person, approved and paid by another (never who prepared, edited, changed a salary in it or is paid by it), booked through the accounting core when paid; advances asked for and decided by two people. Missing: an off-cycle settlement for one leaver (they are settled in their month's run, pro-rated) and advances in instalments; there is no salaries-payable account, so pay is booked when paid (requested).",
      "مسيرات شهرية: الأساسي بحسب أيام العمل والإجازة بلا راتب، والعمولات، والمكافآت والخصومات بملاحظة، والسلف؛ يُعدّها شخص ويعتمدها ويصرفها آخر (لا من أعدّها أو عدّلها أو غيّر راتباً فيها أو يُدفع له منها)، وتُقيَّد عبر نواة المحاسبة عند الصرف؛ والسلف يطلبها شخص ويقررها آخر. ناقص: تسوية منفصلة لموظف مغادر (يُسوّى في مسير شهره بالأيام) والسلف بالأقساط؛ ولا يوجد حساب رواتب مستحقة فتُقيَّد عند الصرف (طُلب).",
    ),
  },
  "15.05": {
    status: "implemented",
    route: "/admin/staff/performance",
    note: n(
      "Each employee's month: counter sales net of refunds, units, average basket, refunds, attendance (planned, attended, late, missed, hours), tasks and orders packed — no cost, margin or profit is read; commission only for who sees pay.",
      "شهر كل موظف: مبيعات الصندوق بعد المسترد، والقطع، ومتوسط السلة، والمسترد، والحضور (المخطط والحاضر والمتأخر والغائب والساعات)، والمهام والطلبات المجهّزة — دون قراءة أي تكلفة أو هامش أو ربح؛ والعمولة لمن يرى الرواتب فقط.",
    ),
  },
  "15.06": {
    status: "partial",
    route: "/admin/staff/approvals",
    note: n(
      "One view of what waits for this employee across modules (the bell's own queues, plus leave and payroll runs), their own requests awaiting others, and — with staff.approval.read — the store's pending requests without their amounts, each linking to the module's own decision screen. Missing: a till discount above the cashier's limit and a direct stock adjustment have no request-and-approve step — the permission alone decides (modules 06 and 04).",
      "عرض واحد لما ينتظر قرار الموظف في الأقسام (قوائم الجرس نفسها، والإجازات ومسيرات الرواتب)، وطلباته التي تنتظر غيره، و— بصلاحية عرض الطلبات المعلّقة — طلبات المتجر المعلّقة دون مبالغها، وكلٌّ يفتح شاشة القرار في قسمه. ناقص: خصم الصندوق فوق حد الكاشير وتسوية المخزون المباشرة بلا خطوة طلب واعتماد — الصلاحية وحدها تقرر (القسمان 06 و04).",
    ),
  },
  "15.07": {
    status: "implemented",
    route: "/admin/staff/employees",
    note: n(
      "Ending access on termination from the employee's file (staff.manage, a reason, the impact shown): the sign-in service disables the account and ends every session at once (refused on the next request), then future shifts and pending leave are cancelled; never one's own account nor a stronger one. The employee's live sessions (end one or all) and their sign-in log.",
      "إنهاء الوصول عند انتهاء الخدمة من ملف الموظف (صلاحية إدارة الموظفين، وسبب، ويُعرض الأثر): توقف خدمة الدخول الحساب وتنهي كل جلساته فوراً (يُرفض طلبه التالي)، ثم تُلغى ورديته القادمة وإجازاته المعلّقة؛ ولا لحساب الشخص نفسه ولا لحساب أقوى منه. وجلسات الموظف المفتوحة (إنهاء واحدة أو الكل) وسجل دخوله.",
    ),
  },

  // ── 16 Marketing and growth
  "16.01": {
    status: "boundary",
    route: "/admin/marketing/campaigns",
    note: n(
      "Campaigns are prepared, approved by a second person (never the requester nor anyone who wrote it) and released, only to people with an explicit, current marketing consent (guest checkouts per number count; merged, deleted and blocked accounts never), within 2 marketing messages per person per 7 days, checked again inside the write. No SMS, WhatsApp or e-mail provider is connected: released messages are held in the outbox and never shown as sent. Releasing at the scheduled time is by hand until the jobs owner schedules releaseDueCampaigns.",
      "تُجهَّز الحملات ويعتمدها شخص ثانٍ (لا من طلبها ولا من كتبها) وتوضع في صندوق الإرسال، لمن لديه موافقة تسويق صريحة وحالية فقط (موافقة الضيف لرقمه تُحسب؛ الحسابات المدموجة والمحذوفة والمحظورة لا يصلها شيء)، وبحد رسالتين تسويقيتين للشخص كل 7 أيام، ويُعاد الفحص لحظة الكتابة. لا يوجد مزوّد رسائل نصية أو واتساب أو بريد: الرسائل محجوزة ولا تُعرض مرسلة. الوضع في الموعد يدوي حتى يجدول مالك المهام releaseDueCampaigns.",
    ),
  },
  "16.02": {
    status: "boundary",
    route: "/admin/marketing/carts",
    note: n(
      "Abandoned carts of known, consenting customers with a verdict each; one held reminder per cart, one cart reminder per person per 7 days, the marketing limit, quiet hours, nothing when the customer ordered since or nothing is buyable — checked again inside the write. No SMS provider: reminders are held, never delivered, and conversions after them are shown as not caused by them. Staff prepare reminders by hand until a scheduled job is added (requested of the jobs owner).",
      "السلال المتروكة لعملاء معروفين موافقين مع حكم لكل سلة؛ تذكير محجوز واحد لكل سلة، وتذكير سلة واحد للشخص كل 7 أيام، وحد الرسائل التسويقية، وساعات الهدوء، ولا شيء إن طلب العميل بعدها أو لم يبقَ شيء متاح — ويُعاد الفحص لحظة الكتابة. لا مزوّد رسائل نصية: التذكيرات محجوزة لا تصل، والتحول بعدها يُعرض على أنه ليس بسببها. يجهّزها الموظفون يدوياً حتى تُضاف مهمة مجدولة (طُلبت من مالك المهام).",
    ),
  },
  "16.03": {
    status: "implemented",
    route: "/admin/marketing/segments",
    note: n(
      "Who bought which platform in which period (accepted orders, Baghdad days), narrowed by module 07's stored segments (reused, not recomputed), with how many may be messaged now and why the others are left out; a campaign starts from the same audience.",
      "من اشترى أي منصة وفي أي فترة (طلبات مؤكدة، أيام بغداد)، مضيّقاً بأقسام القسم 07 المحفوظة (يُعاد استخدامها دون إعادة حساب)، وكم منهم يمكن مراسلته الآن ولماذا استُبعد الباقون؛ وتبدأ الحملة من الجمهور نفسه.",
    ),
  },
  "16.04": {
    status: "partial",
    route: "/admin/marketing/links",
    note: n(
      "Missing: the storefront does not record the source — no page reads utm_* or tt_l and placeOrder writes neither orders.utm_link_id nor orders.attribution (requested of the storefront and the commerce core), and nothing counts clicks. The link builder (CMS path rules, a page that does not exist is refused), the links per campaign and the attribution read are built; attribution counts only orders that really carry their source — none today, and the page says so.",
      "الناقص: واجهة المتجر لا تسجل المصدر — لا صفحة تقرأ utm_* أو tt_l، ولا يكتب placeOrder حقلي orders.utm_link_id و orders.attribution (طُلب من الواجهة ونواة التجارة)، ولا شيء يعدّ النقرات. منشئ الروابط (بقواعد مسارات المحتوى، ويُرفض رابط لصفحة غير موجودة) وروابط كل حملة وقراءة الإسناد مبنية؛ والإسناد يحسب فقط طلبات تحمل مصدرها فعلاً — لا شيء اليوم، والصفحة تقول ذلك.",
    ),
  },
  "16.05": {
    status: "implemented",
    route: "/admin/marketing/cross-sell",
    note: n(
      "Staff rules on the recommendation engine's pin / boost / exclude per device and shelf, with a window and a reason; a pin or a boost only for an add-on verified on the device (checked again when switched back on). Each rule says what it does on the storefront now, and the device's setup shelf is shown as shoppers see it.",
      "قواعد الموظفين على تثبيت المحرك وأولويته واستبعاده لكل جهاز ورف، بمدة وسبب؛ التثبيت والأولوية لملحق متحقق من توافقه مع الجهاز فقط (ويُعاد الفحص عند إعادة التشغيل). كل قاعدة تقول ما تفعله في المتجر الآن، ويُعرض رف الجهاز كما يراه المتسوق.",
    ),
  },
  "16.06": {
    status: "partial",
    route: "/admin/marketing/reviews",
    note: n(
      "Missing: customers cannot write a review from the store (no form; requested of the product area) and there is no customer photo content. Moderation is built: approve only a verified purchase that holds up inside the write (delivered order of the same customer and product), reject with a reason code, never because a review is negative; nothing creates or changes a rating.",
      "الناقص: لا يستطيع العملاء كتابة مراجعة من المتجر (لا نموذج؛ طُلب من منطقة المنتج) ولا محتوى صور من العملاء. المراجعة مبنية: يُعتمد الشراء المؤكد فقط إن ثبت لحظة الكتابة (طلب مُسلَّم للعميل نفسه والمنتج نفسه)، ويُرفض بسبب مرمّز، ولا يُرفض لأنه سلبي؛ ولا شيء يصنع تقييماً أو يغيّره.",
    ),
  },
  "16.07": {
    status: "partial",
    route: "/admin/marketing/performance",
    note: n(
      "Missing: ROAS cannot be computed — no order carries its source until the storefront records it (16.04). Built: spend entered per campaign and month (per campaign only here — the finance books hold marketing expenses as a whole, not per campaign; corrections as negative entries), blended CAC per month, LTV from real orders (paid minus refunded), LTV ÷ CAC, each with its definition (docs/metrics.md §8) and source; CSV (audited) and print. No cost or profit is used.",
      "الناقص: لا يمكن حساب العائد على الإنفاق — لا طلب يحمل مصدره حتى تسجله الواجهة (16.04). المبني: الإنفاق يُسجَّل لكل حملة وشهر (لكل حملة هنا فقط — دفاتر المالية تحمل مصروفات التسويق جملةً لا لكل حملة؛ والتصحيح قيد سالب)، وتكلفة الاكتساب المجمعة لكل شهر، وقيمة العميل من الطلبات الحقيقية (المدفوع ناقص المسترد)، والنسبة بينهما، لكل منها تعريفه (docs/metrics.md §8) ومصدره؛ مع CSV (مدقق) وطباعة. لا تُستخدم تكلفة أو ربح.",
    ),
  },

  // ── 17 Content and storefront (owner: admin content module, docs/areas/admin-cms.md)
  "17.01": {
    status: "partial",
    route: "/admin/cms",
    note: n(
      "Policies (delivery, payment, privacy, terms — returns and warranty in Settings), the about and contact texts are drafted, previewed and approved here and the store serves them now. Banners, landing pages, the home sections' order and the pinned hero (a product and a headline per platform and period, checked against the catalogue) are kept and ready, but the storefront does not read them yet: its team wires getActiveBanners, getLandingPage, getHomeLayout and getHomeHero after the redesign.",
      "السياسات (التوصيل والدفع والخصوصية والشروط — الإرجاع والضمان من الإعدادات) ونصّا «من نحن» و«تواصل معنا» تُكتب وتُعاين وتُعتمد هنا ويعرضها المتجر الآن. البانرات وصفحات الهبوط وترتيب أقسام الصفحة الرئيسية والمنتج المثبّت (منتج وعنوان لكل منصة ومدة، يُفحص مع الكتالوج) محفوظة وجاهزة، لكن المتجر لا يقرؤها بعد: يربط فريقه getActiveBanners و getLandingPage و getHomeLayout و getHomeHero بعد إعادة التصميم.",
    ),
  },
  "17.02": {
    status: "partial",
    route: "/admin/cms/schedule",
    note: n(
      "Banners, landing pages and pinned heroes are scheduled in Iraq time and shown on one calendar with the catalogue's release dates (scheduled products, pre-orders, variants to come); a schedule never puts forward a product the catalogue would not show, and never changes a product's status. What is scheduled reaches the store once the storefront reads banners, pins and landing pages (17.01).",
      "تُجدول البانرات وصفحات الهبوط والمنتجات المثبّتة بتوقيت العراق وتظهر في تقويم واحد مع مواعيد الكتالوج (منتجات مجدولة وطلب مسبق ونسخ قادمة)؛ لا تُقدّم الجدولة منتجاً لا يعرضه الكتالوج ولا تغيّر حالة منتج. يصل المجدول إلى المتجر حين يقرأ المتجر البانرات والتثبيت وصفحات الهبوط (17.01).",
    ),
  },
  "17.03": {
    status: "partial",
    route: "/admin/cms/navigation",
    note: n(
      "Search synonyms (ar/en/ckb, normalised as the index) work in the store's search now (/admin/cms/search). The menu stays generated from the catalogue; staff order, hide and feature its entries, and order or hide each category page's filter groups — kept, but the storefront does not read them yet (getNavArrangement, getListingFilterOrder).",
      "مرادفات البحث (عربي/إنجليزي/كوردي، مطبّعة كما في الفهرس) تعمل في بحث المتجر الآن (/admin/cms/search). القائمة تبقى مولّدة من الكتالوج؛ يرتّب الموظفون عناصرها ويخفونها ويبرزونها، ويرتّبون فلاتر صفحات الأقسام أو يخفونها — محفوظة، لكن المتجر لا يقرؤها بعد (getNavArrangement و getListingFilterOrder).",
    ),
  },
  "17.04": {
    status: "partial",
    route: "/admin/cms/seo",
    note: n(
      "Product SEO titles and descriptions (saved through the catalogue's own write path) and page SEO work on the store now, with issues listed (missing, too long, repeated, hidden). Category SEO is kept but the category page does not read it yet. 301/302 redirects refuse the admin and the API, loops and chains — but the storefront does not call resolveRedirect yet.",
      "عناوين محركات البحث وأوصاف المنتجات (تُحفظ عبر مسار الكتالوج نفسه) وأوصاف الصفحات تعمل في المتجر الآن، مع قائمة المشاكل (ناقص، طويل، مكرر، مخفي). عنوان القسم ووصفه محفوظان لكن صفحة القسم لا تقرؤهما بعد. تحويلات 301/302 ترفض لوحة الإدارة والواجهة البرمجية والحلقات والسلاسل — لكن المتجر لا يستدعي resolveRedirect بعد.",
    ),
  },
  "17.05": {
    status: "implemented",
    route: "/admin/cms/search/zero",
    note: n(
      "Searches that found nothing (anonymous daily counts), whether each finds something now, and suggested spellings from the store's own vocabulary with the concept's words in Arabic, English and Sorani; one click adds the query as a synonym. Suggestions are arithmetic on letters: no AI model is configured, so meanings stay a person's call.",
      "عمليات البحث بلا نتائج (عدّ يومي مجهول المصدر)، وهل تجد شيئاً الآن، وكتابات مقترحة من مفردات المتجر مع كلمات الفكرة بالعربية والإنجليزية والكوردية؛ نقرة تضيف العبارة مرادفاً. الاقتراحات حساب على الحروف: لا نموذج ذكاء اصطناعي مضبوط، فالمعاني قرار الموظف.",
    ),
  },
  "17.06": {
    status: "partial",
    route: "/admin/cms/pages",
    note: n(
      "Every banner, page and pinned hero is previewed at phone (390) and desktop (1280) width in ar/en/ckb before publishing, and a signed preview link (7 days, staff only, no-store and noindex) shows the unpublished version. Pages are drawn with the store's own text renderer; banners and pins with the kit's bands until the storefront adds their slots.",
      "يُعاين كل بانر وصفحة ومنتج مثبّت بعرض الهاتف (390) وسطح المكتب (1280) بالعربية والإنجليزية والكوردية قبل النشر، ورابط معاينة موقّع (7 أيام، للموظفين فقط، بلا تخزين ولا فهرسة) يعرض النسخة غير المنشورة. الصفحات تُرسم بمكوّن نصوص المتجر نفسه؛ البانرات والتثبيت بشرائط مكتبة المكونات حتى يضيف المتجر أماكنها.",
    ),
  },

  // ── 18 Reports and BI
  "18.01": {
    status: "implemented",
    route: "/admin/reports/sales",
    note: n(
      "Revenue recognised at delivery, discounts, refunds, delivery income and net revenue from the journal (the accounting core's own figures), split by Baghdad day, platform (each order's amounts split over its lines to the dinar), branch or channel — the rows plus what belongs to no order add up to the books, checked on every request; orders placed, order value, average basket, cancellations, paid sales, refund and return rates. Demo rows only when asked; printable, CSV and XLSX.",
      "الإيراد المحقق عند التسليم والخصومات والاستردادات وإيراد التوصيل وصافي الإيراد من دفتر القيود (أرقام نواة المحاسبة نفسها)، مقسّمة حسب يوم بغداد أو المنصة (مبالغ كل طلب مقسّمة على أسطره بالدينار) أو الفرع أو القناة — ومجموع الصفوف مع ما لا يخص طلباً يساوي الدفتر ويُفحص في كل طلب؛ والطلبات المسجلة وقيمتها ومتوسط السلة والإلغاء والمبيعات المدفوعة ونسبتا الاسترداد والإرجاع. البيانات التجريبية عند الطلب فقط؛ قابل للطباعة وCSV وXLSX.",
    ),
  },
  "18.02": {
    status: "implemented",
    route: "/admin/reports/margin",
    note: n(
      "The profit of every order delivered in the range (docs/metrics.md), split over its lines and summed per SKU: line value less its share of the discount and refunds, less the landed cost of goods from the FIFO layers (less what came back), less commissions, less the net delivery cost (the carrier's charge, cash-on-delivery fees included, minus the fee charged); today's landed cost from pricing beside it; uncosted units and parcels without a recorded charge are counted as incomplete; the books for the same dates beside it. Cost columns need the cost permission, profit columns the profit permission too — absent otherwise, in the page and the files. Card-terminal fees are not recorded anywhere, so they are not in it.",
      "ربح كل طلب سُلّم في الفترة (قاموس المقاييس) مقسّماً على أسطره ومجموعاً لكل SKU: قيمة السطر ناقص حصته من الخصم والاستردادات، ناقص التكلفة الواصلة من طبقات FIFO (ناقص ما عاد)، ناقص العمولات، ناقص صافي كلفة التوصيل (ما تقاضته شركة الشحن مع رسوم الدفع عند الاستلام ناقص رسوم التوصيل)؛ والتكلفة الواصلة اليوم من التسعير بجانبه؛ والقطع بلا تكلفة والطرود بلا كلفة مسجلة تُعدّ ناقصة؛ ودفتر التواريخ نفسها بجانبه. أعمدة التكلفة تحتاج صلاحية التكلفة، وأعمدة الربح صلاحية الربح أيضاً — غائبة دونها في الصفحة والملفات. رسوم أجهزة البطاقة غير مسجلة في أي مكان، فلا تدخل فيه.",
    ),
  },
  "18.03": {
    status: "implemented",
    route: "/admin/reports/inventory",
    note: n(
      "ABC by the range's net revenue or units (A = the first 80 % of the value, B the next 15 %, C the rest) with what is on hand now and the A items out of stock; stock turnover and dead stock are module 04's own report, reused (they need the inventory reports permission).",
      "تحليل ABC حسب صافي إيراد الفترة أو قطعها (A أول 80% من القيمة، B الـ15% التالية، C الباقي) مع المخزون الآن ومنتجات A النافدة؛ ودوران المخزون والمخزون الراكد تقرير قسم المخزون نفسه يُعاد استخدامه (يحتاج صلاحية تقارير المخزون).",
    ),
  },
  "18.04": {
    status: "implemented",
    route: "/admin/reports/customers",
    note: n(
      "Cohorts by the month of the first purchase with the share who bought in each later month (a month not reached yet is shown as not reached, never 0 %), repeat purchases and days to the second purchase, value per customer, and every customer's value by module 07's RFM segment. A purchase and its value are module 07's definitions (what the store kept: paid − refunded); guests are counted apart; aggregates only. A profit-based customer value (per-order profit over a customer's history) is not computed yet.",
      "مجموعات حسب شهر أول شراء ونسبة من اشترى في كل شهر بعده (الشهر الذي لم يأتِ يُعرض كذلك، لا 0%)، وتكرار الشراء والأيام حتى الشراء الثاني، والقيمة لكل عميل، وقيمة العملاء حسب شرائح RFM للقسم 07. تعريف الشراء وقيمته من القسم 07 (ما احتفظ به المتجر: المدفوع − المردود)؛ والزوار يُعدّون منفصلين؛ أرقام مجمّعة فقط. قيمة العميل بالربح (ربح كل طلب عبر تاريخ العميل) لا تُحسب بعد.",
    ),
  },
  "18.05": {
    status: "implemented",
    route: "/admin/reports/performance",
    note: n(
      "Suppliers by module 09's rating; employees' counter sales, refunds on them and packing by module 15's month performance (no cost, no pay); shipping per carrier — delivery success, first-attempt success, failed tries, days to deliver, cash-on-delivery settlement time and what still waits; customer service by module 14's response and resolution times. The employee and service sections also need their module's own permission.",
      "الموردون بتقييم القسم 09؛ ومبيعات الموظفين في نقطة البيع والاستردادات عليها والتجهيز من أداء القسم 15 الشهري (بلا تكلفة ولا أجور)؛ والشحن لكل شركة — نجاح التوصيل والنجاح من أول محاولة والمحاولات الفاشلة وأيام التوصيل ووقت تسوية الدفع عند الاستلام وما ينتظر؛ وخدمة العملاء بأوقات الرد والحل للقسم 14. قسما الموظفين وخدمة العملاء يحتاجان صلاحية قسمهما أيضاً.",
    ),
  },
  "18.06": {
    status: "partial",
    route: "/admin/reports/saved",
    note: n(
      "Saved reports (any report's view under a name, for oneself or shared with those who may open it; owner-only rename and delete with a reason, audited) and CSV / XLSX exports of every report with exactly the figures the page shows (formula-safe, audited). Missing: scheduled delivery — no e-mail provider is configured, so no schedule is offered.",
      "التقارير المحفوظة (عرض أي تقرير باسم، لصاحبه أو مشتركاً مع من يملك صلاحية فتحه؛ يعدّله صاحبه أو يحذفه بسبب، مع سجل تدقيق) وتصدير كل تقرير CSV وXLSX بالأرقام التي تعرضها الصفحة نفسها (آمن من الصيغ، مسجّل). الناقص: الإرسال المجدول — لا مزود بريد مُعدّ، فلا يُعرض أي جدول.",
    ),
  },
  "18.07": {
    status: "implemented",
    route: "/admin/reports/dictionary",
    note: n(
      "One dictionary in the admin: every metric of docs/metrics.md (a test keeps the two in step) with its source, the permission it needs, the reports that show it and the code that computes it, plus the reports' own figures written from those definitions. The period's revenue, cost and profit come from the accounting core alone; the profit of one order (net margin per SKU) follows the dictionary's own definition. Read-only by design: a definition changes with docs/metrics.md and its implementation, never through a form.",
      "قاموس واحد في لوحة الإدارة: كل مقياس في docs/metrics.md (اختبار يبقيهما متطابقين) مع مصدره والصلاحية التي يحتاجها والتقارير التي تعرضه والكود الذي يحسبه، وأرقام التقارير مكتوبة من تلك التعريفات. إيراد الفترة وتكلفتها وربحها من نواة المحاسبة وحدها؛ وربح الطلب الواحد (صافي الهامش لكل SKU) بتعريف القاموس نفسه. للقراءة فقط عمداً: يتغير التعريف مع الوثيقة وحسابها، لا من نموذج.",
    ),
  },

  // ── 19 Automation and AI
  "19.01": {
    status: "partial",
    route: "/admin/automation/rules",
    note: n(
      "Rules from a fixed catalogue (new order, stock at its reorder point, a ticket waiting, a price change) with typed conditions and actions that hand work to a person (a staff task, a notice inside the admin, a review flag, a purchase suggestion); every save a new version, audited; a run log. They run with the scheduled job only once the platform schedules runAutomation (requested); until then a person runs them with 'run the active rules now'. Notices are not sent by message (no provider).",
      "قواعد من قائمة ثابتة (طلب جديد، مخزون عند حد إعادة الطلب، تذكرة تنتظر، تغيّر سعر) بشروط وإجراءات محددة تسلّم العمل لشخص (مهمة، تنبيه داخل الإدارة، علامة مراجعة، اقتراح شراء)؛ كل حفظ نسخة جديدة مدققة؛ وسجل تنفيذ. تعمل مع التشغيل المجدول فقط بعد أن تجدول المنصة runAutomation (طُلب ذلك)؛ وحتى ذلك يشغّلها شخص بزر «شغّل القواعد المفعّلة الآن». التنبيهات لا تُرسل برسائل (لا مزوّد).",
    ),
  },
  "19.02": {
    status: "partial",
    route: "/admin/automation/suggestions",
    note: n(
      "Suggestions from the inventory module's reorder figures, one per SKU until new stock arrives, dismissed with a reason or turned into a draft purchase order of module 09 (whose approval rules apply). The stock is checked on its own only once the platform schedules runAutomation (requested); meanwhile 'check the stock now'. The admin bell does not count them yet (asked of the shell owner).",
      "اقتراحات من أرقام إعادة الطلب في المخزون، اقتراح لكل صنف حتى تصل بضاعة جديدة، تُستبعد بسبب أو تصير مسودة أمر شراء في القسم 09 (بقواعد اعتماده). يُفحص المخزون تلقائياً فقط بعد أن تجدول المنصة runAutomation (طُلب ذلك)؛ وحتى ذلك «افحص المخزون الآن». جرس الإدارة لا يعدّها بعد (طُلب من مالك الواجهة).",
    ),
  },
  "19.03": {
    status: "partial",
    route: "/admin/automation/tickets",
    note: n(
      "Topics and canned-reply suggestions by written keyword rules, labelled as rules, never as AI; the change and the reply happen on the ticket's page. Summaries and written reply suggestions need a language model, which is not configured.",
      "مواضيع واقتراح ردود جاهزة بقواعد كلمات مكتوبة، معلنة كقواعد لا كذكاء اصطناعي؛ التغيير والرد في صفحة التذكرة. التلخيص واقتراح ردود مكتوبة يحتاجان نموذجاً لغوياً غير مُعدّ.",
    ),
  },
  "19.04": {
    status: "implemented",
    route: "/admin/automation/anomalies",
    note: n(
      "Deterministic checks with written thresholds (large refunds, large discounts, orders far above usual, cost jumps with cost.read) next to finance 10.10's checks and purchasing 09.07's variances, for those who may read them; worked out when the page opens.",
      "فحوص ثابتة بحدود مكتوبة (استردادات وخصومات كبيرة، طلبات أكبر بكثير من المعتاد، قفزات التكلفة لمن يرى التكلفة) بجانب فحوص المالية 10.10 وفروقات المشتريات 09.07 لمن يحق له؛ تُحسب عند فتح الصفحة.",
    ),
  },
  "19.05": {
    status: "implemented",
    route: "/admin/automation/forecast",
    note: n(
      "A three-month moving average of units sold, times last year's index for the month once 12 months exist, with the months shown; launches from the catalogue's release dates with pre-orders; short history says so. Kept monthly in demand_forecasts once the platform schedules storeDemandForecasts (requested).",
      "متوسط متحرك لثلاثة أشهر من الوحدات المباعة، مضروباً في مؤشر الشهر من العام الماضي بعد 12 شهراً، مع عرض الأشهر؛ والإطلاقات من تواريخ الإصدار مع الحجوزات المسبقة؛ والتاريخ القصير يُذكر كما هو. يُحفظ شهرياً بعد أن تجدول المنصة storeDemandForecasts (طُلب ذلك).",
    ),
  },
  "19.06": {
    status: "boundary",
    route: "/admin/automation/assistant",
    note: n("Needs a language model the owner chooses (provider, key, and a decision on which data may leave); none is configured. The page says what it would have to respect.", "يحتاج نموذجاً لغوياً يختاره المالك (مزوّد ومفتاح وقرار بما يجوز أن يغادر من البيانات)؛ لا شيء مُعدّ. الصفحة تقول ما يجب أن يلتزم به."),
  },
  "19.07": {
    status: "implemented",
    route: "/admin/automation/rules",
    note: n(
      "A rule is switched on only after a dry run of its current version (7 / 30 / 90 days; stock as it is now) that is at most 7 days old, and never by the author of that version; the dry run writes only its summary and samples.",
      "لا تُفعّل قاعدة إلا بعد محاكاة نسختها الحالية (7 / 30 / 90 يوماً؛ المخزون كما هو الآن) لم يمضِ عليها أكثر من 7 أيام، ولا يفعّلها كاتب تلك النسخة؛ المحاكاة لا تكتب إلا ملخصها وعيناتها.",
    ),
  },
  "19.08": {
    status: "implemented",
    route: "/admin/automation",
    note: n(
      "No automation action refunds, changes a price, moves stock or money or approves anything: refunds keep 05/12's second person, prices 03's approval limits, purchase orders 09's approval; a rule only creates a request for a person (tested by counting those tables).",
      "لا إجراء أتمتة يسترد مالاً أو يغيّر سعراً أو يحرّك مخزوناً أو مالاً أو يعتمد شيئاً: الاسترداد يبقى بموافقة شخص ثانٍ في 05/12، والأسعار بحدود الموافقة في 03، وأوامر الشراء باعتماد 09؛ القاعدة تنشئ طلباً لشخص فقط (مختبر بعدّ تلك الجداول).",
    ),
  },

  // ── 20 Security and compliance
  "20.01": {
    status: "partial",
    route: "/admin/security/staff",
    note: n(
      "Two-step status and coverage per role; other employees' sessions ended and two-step reset (owner; never of an account holding more than the resetter), with a reason and audited; one's own on /admin/me. Missing: trusted devices and two-step required per role — the sign-in service has neither.",
      "حالة التحقق بخطوتين والتغطية لكل دور؛ وإنهاء جلسات الموظفين الآخرين وإعادة ضبط تحققهم (المالك؛ ولا لحساب يملك أكثر ممن يعيد الضبط)، بسبب ومسجل؛ وإعدادات الموظف نفسه في /admin/me. ناقص: الأجهزة الموثوقة وفرض التحقق بخطوتين لدور — خدمة الدخول لا تدعمهما.",
    ),
  },
  "20.02": {
    status: "partial",
    route: "/admin/security/roles",
    note: n(
      "Role editor with field-level permissions marked, new roles, an employee's roles and branch limit — wildcard owner-only, nothing granted or taken away beyond one's own (only an owner takes the owner role), no edit of one's own role, last owner kept, impact shown, audited. Missing: no branch exists yet (module 21).",
      "محرر الأدوار مع تمييز صلاحيات الحقول، وأدوار جديدة، وأدوار الموظف وحدّ فرعه — الصلاحية الشاملة للمالك وحده، ولا منح ولا سحب فوق ما يملكه الشخص (ولا يسحب دور المالك إلا مالك)، ولا تعديل لدوره، ويبقى آخر مالك، ويُعرض الأثر ويُسجل. ناقص: لا يوجد فرع بعد (القسم 21).",
    ),
  },
  "20.03": {
    status: "implemented",
    route: "/admin/security/audit",
    note: n(
      "Filters, CSV export, each event's before and after (cost hidden without cost.read), chain verification and sealing — both recorded; sealed daily by the scheduled job.",
      "التصفية والتصدير CSV وما قبل كل حدث وبعده (تُحجب التكلفة بلا صلاحيتها)، والتحقق من السلسلة وختمها — وكلاهما مسجل؛ ويُختم يومياً بالمهمة المجدولة.",
    ),
  },
  "20.04": {
    status: "partial",
    route: "/admin/security/protections",
    note: n(
      "The data key's self-test, authenticator secrets readable with it, and counts of protected records — never a secret. Missing: rotating the data key (re-encrypting under a new DATA_KEY); digital codes are module 13's.",
      "فحص ذاتي لمفتاح البيانات، وأسرار تطبيق المصادقة المقروءة به، وأعداد السجلات المحمية — دون أي سر. ناقص: تدوير مفتاح البيانات (إعادة التشفير بمفتاح DATA_KEY جديد)، والرموز الرقمية من القسم 13.",
    ),
  },
  "20.05": {
    status: "partial",
    route: "/admin/security/backups",
    note: n(
      "The recovery plan with its wrangler commands (D1 Time Travel keeps 30 days) and restore tests recorded as evidence, due every 90 days. Backups and restores run in Cloudflare, not from the app; uploaded files (KV) have no history.",
      "خطة التعافي بأوامر wrangler (يحتفظ D1 Time Travel بثلاثين يوماً)، وتسجيل اختبارات الاستعادة كدليل، ويُستحق اختبار كل 90 يوماً. النسخ والاستعادة تتم في Cloudflare لا من التطبيق، والملفات المرفوعة (KV) بلا سجل زمني.",
    ),
  },
  "20.06": {
    status: "boundary",
    route: "/admin/security/protections",
    note: n(
      "Built: every duplicate rule checked in the database, flagged duplicate payment proofs and wallet top-ups, incoming provider events keyed by provider and event id. Needs a payment provider: none is connected, so no webhook arrives yet (21.05).",
      "المنفذ: فحص كل قاعدة لمنع التكرار في قاعدة البيانات، وإثباتات الدفع وطلبات شحن المحفظة المكررة المعلّمة، والأحداث الواردة بمفتاح المزود ومعرف الحدث. يحتاج مزود دفع: لا يوجد مزود متصل، فلا تصل إشعارات Webhook بعد (21.05).",
    ),
  },
  "20.07": {
    status: "implemented",
    route: "/admin/security/retention",
    note: n(
      "Retention periods (set in code) with the daily job's last run; a customer's deletion request is 07.04. Access reviews of each role every 90 days, recorded in the audit trail.",
      "مدد الاحتفاظ (محددة في الكود) مع آخر تشغيل للمهمة اليومية، وطلب حذف بيانات زبون في 07.04. مراجعة صلاحيات كل دور كل 90 يوماً، وتُسجل في سجل التدقيق.",
    ),
  },
  "20.08": {
    status: "implemented",
    route: "/admin/security/sign-ins",
    note: n(
      "Sign-in alerts by rule (24 hours, 7 or 30 days) and the sign-in log, phones masked without customer.phone.read_full; refund reviews with their signals on /admin/security/refunds, never by who asked for or approved the refund.",
      "تنبيهات الدخول حسب القاعدة (24 ساعة أو 7 أو 30 يوماً) وسجل الدخول، والهواتف مخفية بلا صلاحية رؤيتها كاملة؛ ومراجعة الاستردادات بإشاراتها في /admin/security/refunds، ولا يراجعها من طلبها أو وافق عليها.",
    ),
  },

  // ── 21 Branches, channels and integrations
  "21.01": {
    status: "partial",
    route: "/admin/channels/branches",
    note: n(
      "Branches: add, edit (stale forms refused) and switch off — refused while active locations, registers, limited employees or price lists use it — with what belongs to each one in modules 03, 04, 06 and 20; per channel, where its stock, prices and delivery come from today (/admin/channels/sales), linked to the module that decides it. Missing: an existing location cannot be moved under a branch (module 04's location edit has no branch), the online checkout does not apply price lists (the commerce core), and the two built-in channels have no on/off switch that the checkout or the till would read.",
      "الفروع: إضافة وتعديل (يُرفض النموذج القديم) وإيقاف — يُرفض ما دامت مواقع أو نقاط بيع أو موظفون مقيّدون أو قوائم أسعار فعالة تستخدمه — مع ما يخص كل فرع في الأقسام 03 و04 و06 و20؛ ولكل قناة من أين تأخذ مخزونها وأسعارها وتوصيلها اليوم (\u2066/admin/channels/sales\u2069) مع رابط القسم الذي يقرر ذلك. ناقص: لا يُنقل موقع موجود إلى فرع (تعديل الموقع في القسم 04 بلا فرع)، والدفع في المتجر لا يطبّق قوائم الأسعار (نواة التجارة)، والقناتان المدمجتان بلا مفتاح تشغيل يقرؤه الدفع أو نقطة البيع.",
    ),
  },
  "21.02": {
    status: "partial",
    route: "/admin/channels/orders",
    note: n(
      "Orders of every channel for a period — placed, open, delivered, cancelled, returned, order value and average basket — each linked to the list that shows them (module 05 lists online and till orders together; module 06 the till's sales). Missing: a channel filter on module 05's list (requested); no outside marketplace is connected, so none of its orders can arrive.",
      "طلبات كل قناة لفترة — المسجلة والمفتوحة والمسلّمة والملغاة والمرتجعة وقيمتها ومتوسط السلة — مع رابط القائمة التي تعرضها (القسم 05 يعرض طلبات المتجر ونقاط البيع معاً، والقسم 06 مبيعات نقاط البيع). ناقص: تصفية حسب القناة في قائمة القسم 05 (طُلبت)، ولا سوق خارجي متصل فلا تصل طلباته.",
    ),
  },
  "21.03": {
    status: "partial",
    route: "/admin/channels/api",
    note: n(
      "API keys with scopes (only ones the creator holds — and only while they hold them: a key stops when its creator's account is disabled or limited to a branch), an expiry and a rate a minute — shown once, only the hash kept, revoked with a reason, audited; a read-only API (products, stock, orders: no cost, no customer data, every call audited) documented on /admin/channels/api/docs; webhooks with a signing secret encrypted with DATA_KEY, order events queued once and signed. Missing: GET /api/v1 is not registered in the server's routes yet (requested), the scheduled queue and delivery jobs are not registered (requested), and nothing is sent to an outside address (no safe transport — the boundary of 21.04).",
      "مفاتيح API بصلاحيات (مما يملكه منشئها فقط، وما دام يملكها: يتوقف المفتاح إن عُطّل حساب منشئه أو قُيّد بفرع) وتاريخ انتهاء وحد في الدقيقة — تظهر مرة واحدة ولا يُحفظ إلا بصمتها، وتُلغى بسبب، ومسجلة في التدقيق؛ وواجهة للقراءة فقط (المنتجات والمخزون والطلبات: بلا تكلفة ولا بيانات زبائن، وكل طلب مسجل) موثقة في \u2066/admin/channels/api/docs\u2069؛ وWebhooks بسرّ توقيع مشفر بمفتاح DATA_KEY، وأحداث الطلبات تُصفّ مرة واحدة وتُوقّع. ناقص: المسار \u2066GET /api/v1\u2069 غير مسجل في مسارات الخادم بعد (طُلب)، ومهام الصف والإرسال المجدولة غير مسجلة (طُلبت)، ولا يُرسل شيء إلى عنوان خارجي (لا وسيلة إرسال آمنة — حدّ 21.04).",
    ),
  },
  "21.04": {
    status: "boundary",
    route: "/admin/channels/monitor",
    note: n(
      "Built: one delivery per event per webhook, each attempt claimed before it is sent (two runs never send it twice), retries with backoff, given up after six attempts, a person's retry repeats the same delivery with its ids (never while an attempt is out), a burst of events larger than one scan is queued over the next runs, failures and incoming provider events on one page; an incoming event is stored with its effect in one batch, so a repeat never duplicates an order or an entry. Needs a delivery transport that refuses private and metadata addresses after DNS resolution, and a connected provider: none exists, so nothing is sent and no event arrives.",
      "المنفذ: إرسال واحد لكل حدث لكل Webhook، وكل محاولة تُحجز قبل إرسالها (لا يرسلها تشغيلان مرتين)، وإعادة محاولة بفواصل متزايدة، والتوقف بعد ست محاولات، وإعادة شخص للمحاولة تكرر الإرسال نفسه بمعرّفاته (لا أثناء محاولة جارية)، ودفعة أحداث أكبر من فحص واحد تُصفّ في الجولات التالية، والإخفاقات والأحداث الواردة من المزوّدين في صفحة واحدة؛ والحدث الوارد يُخزَّن مع أثره في دفعة واحدة فلا يكرر تكراره طلباً ولا قيداً. يحتاج وسيلة إرسال ترفض العناوين الخاصة وعناوين البيانات الوصفية بعد حل الاسم، ومزوّداً متصلاً: لا يوجد، فلا يُرسل شيء ولا يرد حدث.",
    ),
  },
  "21.05": {
    status: "boundary",
    route: "/admin/channels/providers",
    note: n(
      "Built: the registry of payment and messaging providers that operate in Iraq and the store's own couriers (module 11), each shown as not connected; the owner may keep a provider's settings and its secret ready — encrypted with DATA_KEY, never shown again, never logged — and remove it. Needs a provider agreement and an adapter for each provider: none is built, so nothing is ever shown as connected and messages stay held.",
      "المنفذ: سجل مزوّدي الدفع والرسائل العاملين في العراق وشركات توصيل المتجر نفسه (القسم 11)، وكل منهم «غير متصل»؛ ويحفظ المالك إعدادات المزوّد وسرّه جاهزة — مشفرة بمفتاح DATA_KEY ولا تُعرض مرة أخرى ولا تُسجَّل — ويحذفها. يحتاج اتفاقاً مع المزوّد وربطاً برمجياً لكل منهم: لم يُبنَ أي ربط، فلا يظهر أي مزوّد متصلاً وتبقى الرسائل معلّقة.",
    ),
  },
  "21.06": {
    status: "implemented",
    route: "/admin/channels/profit",
    note: n(
      "The channel list (/admin/channels/sales) and, per channel and the POS per branch, revenue, discounts, refunds and delivery fees from the journal; the cost of goods and carrier costs with cost.read; gross profit, the channel's contribution and margins with profit.read too — absent, never zero, without them, also when printed; what has no channel and the commissions booked with payroll on their own lines, adding up to the finance module's net profit (docs/metrics.md); printed on an A4 landscape sheet. For employees without a branch limit: the report covers every branch and the store's net profit. Added marketplace channels show no sales: none is connected.",
      "قائمة القنوات (\u2066/admin/channels/sales\u2069)، ولكل قناة ولنقاط البيع حسب الفرع: الإيراد والخصومات والاستردادات ورسوم التوصيل من دفتر اليومية؛ وتكلفة البضاعة وكلفة الشحن مع صلاحية التكلفة؛ ومجمل الربح ومساهمة القناة والهوامش مع صلاحية الربح أيضاً — غائبة لا صفرية بدونها، وفي الطباعة أيضاً؛ وما بلا قناة والعمولات المقيدة مع الرواتب في سطرين خاصين، ومجموعها يطابق صافي ربح القسم المالي (\u2066docs/metrics.md\u2069)؛ ويُطبع على ورقة A4 بالعرض. للموظفين غير المقيّدين بفرع: التقرير يشمل الفروع كلها وصافي ربح المتجر. القنوات المضافة للأسواق بلا مبيعات: لا سوق متصل.",
    ),
  },

  // ── 22 Settings and administration
  "22.01": {
    status: "implemented",
    route: "/admin/settings/currency",
    note: n(
      "Iraqi dinars, whole and fixed; the store's USD rate in force with the date it took effect, scheduled rates and the history. The rate is entered on /admin/pricing/fx (module 03).",
      "الدينار العراقي، صحيحاً وثابتاً؛ وسعر الدولار الساري لدى المتجر مع تاريخ سريانه والأسعار المجدولة والسجل. يُدخل السعر في /admin/pricing/fx (القسم 03).",
    ),
  },
  "22.02": {
    status: "partial",
    route: "/admin/settings/policies",
    note: n(
      "Shipping fee (module 11), tax (module 10; checkout adds no tax — an owner decision), return window and trade-in validity in one place; the return and warranty texts are drafted, approved and withdrawn here. Missing: the store's own warranty terms are undecided.",
      "رسم التوصيل (القسم 11) والضريبة (القسم 10؛ لا يضيف الدفع ضريبة — قرار المالك) ومدة الإرجاع وصلاحية تقدير المقايضة في مكان واحد؛ ونصّا الإرجاع والضمان يُكتبان ويُعتمدان ويُسحبان هنا. ناقص: شروط ضمان المتجر نفسه لم تُقرر بعد.",
    ),
  },
  "22.03": {
    status: "partial",
    route: "/admin/settings/fields",
    note: n(
      "Custom fields per product type (type, options, required, filterable, order, on/off) with the key and a used type locked, options in use kept and the products affected shown; the catalog's product form uses them. Missing: minimum, maximum and pattern rules.",
      "حقول مخصصة لكل نوع منتج (النوع والخيارات والإلزام والتصفية والترتيب والتفعيل)، يُقفل فيها المفتاح والنوع المستخدم وتبقى الخيارات المستخدمة وتظهر المنتجات المتأثرة؛ ويستخدمها نموذج المنتج في الكتالوج. ناقص: قواعد الحد الأدنى والأقصى والنمط.",
    ),
  },
  "22.04": {
    status: "partial",
    route: "/admin/settings/templates",
    note: n(
      "The store's text messages per language, checked against each message's variables, with a preview; files by kind, the latest uploads and uploads nothing refers to (/admin/settings/files). Missing: no SMS provider (21.05) and sending does not use these texts yet; invoices are module 05's.",
      "رسائل المتجر النصية لكل لغة مع فحص متغيرات كل رسالة ومعاينتها؛ والملفات حسب النوع وآخر المرفوعات وما لا يشير إليه شيء (/admin/settings/files). ناقص: لا يوجد مزود رسائل (21.05) ولا يستخدم الإرسال هذه النصوص بعد، والفواتير من القسم 05.",
    ),
  },
  "22.05": {
    status: "partial",
    route: "/admin/settings/locale",
    note: n(
      "Iraq time (Asia/Baghdad, no daylight saving), how dates and numerals are written in each language, and the reading direction, with samples. Missing: the per-language numeral setting and translation corrections are stored but nothing reads them, so neither is offered.",
      "توقيت العراق (Asia/Baghdad، بلا توقيت صيفي)، وكيف يُكتب التاريخ والأرقام في كل لغة، واتجاه القراءة، مع أمثلة. ناقص: إعداد الأرقام لكل لغة وتصحيحات الترجمة مخزنة ولا يقرؤها شيء، فلا يُعرض أي منهما.",
    ),
  },
  "22.06": {
    status: "partial",
    route: "/admin/settings/changes",
    note: n(
      "Every setting with its value, history and a change that needs a reason and the value the person saw; money-control limits need a second person, never the requester; one log of every change and decision. Missing: no separate test deployment — the store mode is a deploy variable, shown read-only.",
      "كل إعداد بقيمته وسجله، وتغيير يحتاج سبباً والقيمة التي رآها الشخص؛ وحدود الرقابة المالية تحتاج شخصاً ثانياً غير الطالب؛ وسجل واحد لكل تغيير وقرار. ناقص: لا توجد نسخة اختبار منفصلة — وضع المتجر متغير نشر يُعرض للقراءة فقط.",
    ),
  },

  // ── 23 Technical operations (owner: admin ops module, docs/areas/admin-ops.md)
  "23.01": {
    status: "partial",
    route: "/admin/ops/errors",
    note: n(
      "Errors the app records itself — one scrubbed row per kind of error (phones masked, e-mails, tokens and URL queries removed), its count and first and last time, kept 90 days — with resolve, ignore and reopen with a reason and a link to an incident. Recorded today: the server and browser errors of the operations pages. Missing: the same recorder on every admin and store page (the shell's layout and the app's error handler, requested from their owners). There is no APM provider: every error is in Cloudflare's Workers Logs, and the page says where.",
      "أخطاء يسجلها التطبيق بنفسه — صف منظَّف لكل نوع خطأ (أرقام الهواتف مخفية، والبريد والرموز واستعلامات الروابط محذوفة) بعدد مراته وأول وآخر ظهور، يُحفظ 90 يوماً — مع المعالجة والتجاهل وإعادة الفتح بسبب وربطه بحادث. يُسجَّل اليوم: أخطاء صفحات التشغيل في الخادم والمتصفح. ناقص: المسجِّل نفسه على كل صفحات الإدارة والمتجر (تخطيط الواجهة ومعالج أخطاء التطبيق، مطلوب من مالكيها). لا يوجد مزود مراقبة: كل خطأ في سجلات Workers في Cloudflare، والصفحة تقول أين.",
    ),
  },
  "23.02": {
    status: "partial",
    route: "/admin/ops/performance",
    note: n(
      "Slow requests (server time ≥ 1 s), failed requests (status ≥ 500), slow page loads (≥ 3 s) and slow navigations (≥ 2 s) per page, day and device — one upsert per slow or failed request, never per request, kept 90 days. Measured today: the operations pages. Missing: the same middleware and browser reporter on every admin page (requested from the shell owner). Rates and percentiles need the request totals that only Cloudflare's metrics hold (no analytics provider); the page gives the steps.",
      "الطلبات البطيئة (زمن خادم ثانية فأكثر) والفاشلة (500 فأكثر)، والتحميل البطيء (3 ثوانٍ فأكثر) والتنقل البطيء (ثانيتان فأكثر) لكل صفحة ويوم وجهاز — كتابة واحدة لكل طلب بطيء أو فاشل، لا لكل طلب، تُحفظ 90 يوماً. يُقاس اليوم: صفحات التشغيل. ناقص: الطبقة الوسطى والمبلّغ نفسهما على كل صفحات الإدارة (مطلوب من مالك الواجهة). النسب والمئينات تحتاج إجمالي الطلبات الذي تملكه مقاييس Cloudflare وحدها (لا مزود تحليلات)، والصفحة تعطي الخطوات.",
    ),
  },
  "23.03": {
    status: "implemented",
    route: "/admin/ops/jobs",
    note: n(
      "Every scheduled job with its cron (the same expressions as wrangler.jsonc), next run, health (late when its schedule stops starting it — a run by hand does not count —, stuck when a run never ends, failing with the failures in a row), last run and last success, and the jobs that need attention as a list of their own; the run history with filters; what a run now would touch, and run now with a reason (ops.job.run, once per form, audited). The message queue: held, queued, sent and failed messages by channel, recipients and provider errors scrubbed, content never shown. Jobs added to the scheduler appear without a change here.",
      "كل مهمة مجدولة بجدولها (تعبيرات wrangler.jsonc نفسها) وتشغيلها القادم وحالتها (متأخرة إن توقف الجدول عن تشغيلها — التشغيل اليدوي لا يُحسب —، عالقة إن لم ينتهِ تشغيل، تفشل مع عدد مرات الفشل المتتالية) وآخر تشغيل وآخر نجاح، والمهام التي تحتاج انتباهاً قائمة وحدها؛ سجل التشغيلات بمرشحات؛ ما سيلمسه التشغيل الآن، والتشغيل اليدوي بسبب (ops.job.run، مرة لكل نموذج، مدقق). طابور الرسائل: المعلّقة والمصطفة والمرسلة والفاشلة حسب القناة، المستلم وأخطاء المزود منظّفة والمحتوى لا يُعرض. أي مهمة تُضاف إلى المجدول تظهر دون تغيير هنا.",
    ),
  },
  "23.04": {
    status: "partial",
    route: "/admin/ops/backups",
    note: n(
      "Monitoring: the age of the last passed restore test (recorded in Security → Backups, never twice), due every 90 days, the daily seal of the audit trail, what D1 Time Travel keeps and how to check it. Missing: backups and restores run in Cloudflare with wrangler — the app cannot read their state without a Cloudflare API token (the owner's decision); uploaded files (KV) have no history.",
      "مراقبة: عمر آخر اختبار استعادة ناجح (يُسجَّل في الأمان ← النسخ الاحتياطي، لا مرتين)، ويُستحق كل 90 يوماً، والختم اليومي لسجل التدقيق، وما يحفظه D1 Time Travel وكيف تتحقق منه. ناقص: النسخ والاستعادة تجري في Cloudflare بأداة wrangler — التطبيق لا يقرأ حالتها دون مفتاح API من Cloudflare (قرار المالك)؛ والملفات المرفوعة (KV) بلا سجل زمني.",
    ),
  },
  "23.05": {
    status: "implemented",
    route: "/admin/ops/incidents",
    note: n(
      "Incidents with a severity, a responsible owner (someone who may read incidents) and a target resolution date — the owner's task — status moves against what the form saw, a timeline of updates and audited changes, the resolution time and a required post-mortem, reopen, links by id to findings, job runs and errors, printed as a report.",
      "حوادث بخطورة ومالك مسؤول (ممن يملك عرض الحوادث) وتاريخ حل مستهدف — مهمة المالك — وتغيير حالة مقابل ما رآه النموذج، وخط زمني للتحديثات والتغييرات المدققة، ووقت الحل وملاحظة ما بعد الحادث الإلزامية، وإعادة الفتح، وروابط بالمعرّف إلى نتائج الفحوص وتشغيلات المهام والأخطاء، وطباعتها تقريراً.",
    ),
  },
  "23.06": {
    status: "partial",
    route: "/admin/ops/consistency",
    note: n(
      "The daily checks' findings (stock against movements and reservations, the wallet against its account and below zero, unbalanced or headless journal entries, orders against their lines, payments and refunds, paid money and delivered orders without their postings): explained, linked to the record in its module, given to a person with a due day, closed as resolved or false positive with a reason (up to 25 at once), reopened — never editing the data checked; numbers of cost checks withheld without cost.read, wallet amounts without a wallet permission; a branch-limited employee sees, takes and closes only findings about their branch's records; run the checks now. Missing on the profit side: a check that each delivered order with known costs has its cost-of-goods posting (requested from the scheduled-jobs owner).",
      "نتائج الفحوص اليومية (المخزون مقابل حركاته وحجوزاته، المحفظة مقابل حسابها وتحت الصفر، القيود غير المتوازنة أو بلا رأس، الطلبات مقابل أسطرها ومدفوعاتها واستردادتها، المال المدفوع والطلبات المسلَّمة بلا قيودها): مشروحة، ومربوطة بالسجل في قسمه، وتُسند لشخص بيوم مستحق، وتُغلق كمحلولة أو إنذار خاطئ بسبب (حتى 25 دفعة واحدة)، وتُعاد فتحها — دون تعديل البيانات المفحوصة أبداً؛ وأرقام فحوص التكلفة مخفية دون cost.read، ومبالغ المحافظ دون صلاحية المحافظ؛ والموظف المقيّد بفرع يرى ويتسلّم ويغلق نتائج سجلات فرعه فقط؛ وتشغيل الفحوص الآن. ناقص في جانب الربح: فحص أن لكل طلب مسلَّم معروف التكلفة قيد تكلفة بضاعته (مطلوب من مالك المهام المجدولة).",
    ),
  },
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
