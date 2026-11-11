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
