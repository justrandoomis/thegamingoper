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
  "21.01": planned(),
  "21.02": planned(),
  "21.03": planned(),
  "21.04": planned(),
  "21.05": planned(n("No payment, shipping or messaging provider is connected.", "لا يوجد مزود دفع أو شحن أو رسائل متصل.")),
  "21.06": planned(),

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
