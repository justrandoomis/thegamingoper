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
