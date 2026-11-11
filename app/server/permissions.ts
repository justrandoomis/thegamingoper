/**
 * The permission catalogue — every action and protected field an employee can be granted.
 *
 * Names are `<module>.<resource>.<action>`, where `<module>` is the admin module's folder name
 * (app/routes/admin/<module>, one per blueprint module 01–23). A few are shorter by contract:
 * `settings.manage`, `staff.manage`, `audit.read`, and the FIELD-LEVEL permissions that decide
 * whether protected data may leave the server at all:
 *
 *   cost.read                 supplier cost, landed cost, acquisition cost          ([P] data)
 *   profit.read               profit and margin figures
 *   customer.phone.read_full  full phone numbers (others see 0771 ••• ••52)
 *   payment_proof.read        transfer-proof images
 *   digital_code.reveal       the plain text of a digital code
 *
 * Authorization is enforced in services: `assertCan(actor, "orders.payment.verify")` from
 * ~/server/actor. Hiding a button is never the control.
 *
 * Roles live in the database (`roles`, `role_permissions`); DEFAULT_ROLES below is what
 * seedRoles() installs. The owner role holds the single wildcard "*" — everything, including
 * permissions added later. No other role may hold the wildcard.
 *
 * Pure data: no imports with side effects, safe for tests and scripts.
 */
import type { L10n } from "~/lib/locales";

/** Admin modules in blueprint order, plus "fields" for the field-level permissions. */
export const PERMISSION_GROUPS = [
  { key: "dashboard", module: "01", ar: "مركز القيادة", en: "Command center" },
  { key: "catalog", module: "02", ar: "كتالوج المنتجات", en: "Product catalog" },
  { key: "pricing", module: "03", ar: "التسعير والربحية", en: "Pricing and profitability" },
  { key: "inventory", module: "04", ar: "المخزون والمستودعات", en: "Inventory and warehouses" },
  { key: "orders", module: "05", ar: "الطلبات والتجهيز", en: "Orders and fulfillment" },
  { key: "pos", module: "06", ar: "نقاط البيع", en: "Point of sale" },
  { key: "customers", module: "07", ar: "العملاء", en: "Customers" },
  { key: "promotions", module: "08", ar: "العروض والولاء", en: "Promotions and loyalty" },
  { key: "purchasing", module: "09", ar: "الموردون والمشتريات", en: "Suppliers and purchasing" },
  { key: "finance", module: "10", ar: "المالية والمحاسبة", en: "Finance and accounting" },
  { key: "shipping", module: "11", ar: "الشحن والتوصيل", en: "Shipping and delivery" },
  { key: "returns", module: "12", ar: "المرتجعات والضمان", en: "Returns and warranty" },
  { key: "devices", module: "13", ar: "الأجهزة والمستعمل والمقايضة", en: "Devices, used and trade-in" },
  { key: "support", module: "14", ar: "خدمة العملاء", en: "Customer service" },
  { key: "staff", module: "15", ar: "الموظفون", en: "Staff" },
  { key: "marketing", module: "16", ar: "التسويق والنمو", en: "Marketing and growth" },
  { key: "cms", module: "17", ar: "المحتوى وتجربة المتجر", en: "Content and storefront" },
  { key: "reports", module: "18", ar: "التقارير", en: "Reports" },
  { key: "automation", module: "19", ar: "الأتمتة والذكاء الاصطناعي", en: "Automation and AI" },
  { key: "security", module: "20", ar: "الأمان والامتثال", en: "Security and compliance" },
  { key: "channels", module: "21", ar: "الفروع والقنوات والتكاملات", en: "Branches, channels and integrations" },
  { key: "settings", module: "22", ar: "الإعدادات", en: "Settings" },
  { key: "ops", module: "23", ar: "التشغيل التقني", en: "Technical operations" },
  { key: "fields", module: null, ar: "بيانات محمية", en: "Protected data" },
] as const;

export type PermissionGroupKey = (typeof PERMISSION_GROUPS)[number]["key"];

type Def = { group: PermissionGroupKey; ar: string; en: string };

/** Keeps each entry on one line while preserving the literal key type. */
const p = (group: PermissionGroupKey, ar: string, en: string): Def => ({ group, ar, en });

export const PERMISSION_DEFS = {
  // ── 01 dashboard
  "dashboard.overview.read": p("dashboard", "فتح لوحة التحكم الخاصة بالدور", "Open the dashboard for their role"),
  "dashboard.sales.read": p("dashboard", "عرض مؤشرات المبيعات والطلبات", "View sales and order KPIs"),
  "dashboard.alerts.read": p("dashboard", "عرض مركز الإجراءات العاجلة", "View the urgent actions centre"),
  "dashboard.funnel.read": p("dashboard", "عرض مسار التحويل من الزيارة إلى التسليم", "View the conversion funnel"),
  "dashboard.activity.read": p("dashboard", "عرض موجز آخر التعديلات والموافقات", "View the feed of recent changes and approvals"),
  "dashboard.search.use": p("dashboard", "استخدام البحث الشامل في الطلبات والعملاء والأصناف", "Use global search across orders, customers, SKUs and serials"),

  // ── 02 catalog
  "catalog.product.read": p("catalog", "عرض المنتجات والمسودات", "View products, including drafts"),
  "catalog.product.create": p("catalog", "إنشاء منتج ومتغيراته", "Create products and variants"),
  "catalog.product.update": p("catalog", "تعديل بيانات المنتج ومتغيراته", "Edit products and variants"),
  "catalog.product.publish": p("catalog", "نشر المنتج أو جدولة نشره أو إخفاؤه", "Publish, schedule or unpublish a product"),
  "catalog.product.archive": p("catalog", "أرشفة منتج", "Archive a product"),
  "catalog.product.import": p("catalog", "استيراد المنتجات وتحريرها جماعياً من ملف CSV", "Bulk import and bulk edit products from CSV"),
  "catalog.product.export": p("catalog", "تصدير بيانات المنتجات", "Export product data"),
  "catalog.version.restore": p("catalog", "استرجاع نسخة سابقة من المنتج", "Restore an earlier product version"),
  "catalog.category.manage": p("catalog", "إدارة شجرة التصنيفات", "Manage the category tree"),
  "catalog.platform.manage": p("catalog", "إدارة المنصات والأجيال وموديلات الأجهزة", "Manage platforms, generations and device models"),
  "catalog.media.manage": p("catalog", "إدارة صور المنتجات والفيديو", "Manage product images and video"),
  "catalog.compatibility.manage": p("catalog", "تعديل قواعد التوافق بين المنتجات والأجهزة", "Edit compatibility rules between products and devices"),
  "catalog.compatibility.verify": p("catalog", "اعتماد قاعدة توافق كمتحقق منها", "Mark a compatibility rule as verified"),
  "catalog.bundle.manage": p("catalog", "إدارة الحزم ومكوناتها", "Manage bundles and their components"),
  "catalog.relation.manage": p("catalog", "إدارة المنتجات المكملة والبدائل والترقيات", "Manage related products: accessories, alternatives and upgrades"),

  // ── 03 pricing
  "pricing.price.update": p("pricing", "طلب تغيير سعر البيع", "Request a selling-price change"),
  "pricing.price.approve": p("pricing", "اعتماد تغييرات الأسعار", "Approve price changes"),
  "pricing.cost.update": p("pricing", "تعديل تكلفة الشراء والتكلفة الواصلة", "Edit purchase cost and landed cost"),
  "pricing.margin.manage": p("pricing", "ضبط الهامش المستهدف والحد الأدنى للربح", "Set target margin and minimum profit rules"),
  "pricing.price_list.manage": p("pricing", "إدارة قوائم الأسعار حسب القناة والفرع والشريحة", "Manage price lists per channel, branch and segment"),
  "pricing.discount.override": p("pricing", "تجاوز حدود الخصم المسموح بها", "Override the allowed discount limits"),
  "pricing.simulation.run": p("pricing", "محاكاة أثر الخصم على هامش الربح", "Simulate the effect of a discount on margin"),
  "pricing.used.update": p("pricing", "تسعير الأجهزة المستعملة وعروض التصفية", "Price used devices and clearance offers"),
  "pricing.suggestion.read": p("pricing", "عرض اقتراحات الأسعار الاسترشادية", "View advisory price suggestions"),
  "pricing.fx_rate.manage": p("pricing", "تحديث سعر صرف الدولار المعتمد في المتجر", "Update the store's USD exchange rate"),

  // ── 04 inventory
  "inventory.stock.read": p("inventory", "عرض أرصدة المخزون لكل موقع", "View stock levels per location"),
  "inventory.stock.adjust": p("inventory", "تسوية المخزون وتسجيل التالف", "Adjust stock and record damage"),
  "inventory.stock.receive": p("inventory", "استلام البضاعة وإدخالها إلى المخزون", "Receive goods into stock"),
  "inventory.movement.read": p("inventory", "عرض سجل حركات المخزون", "View the stock movement log"),
  "inventory.count.perform": p("inventory", "تنفيذ الجرد وإدخال الكميات المعدودة", "Run cycle counts and enter counted quantities"),
  "inventory.count.approve": p("inventory", "اعتماد فروقات الجرد", "Approve count variances"),
  "inventory.transfer.create": p("inventory", "إنشاء تحويل بين المواقع", "Create a transfer between locations"),
  "inventory.transfer.receive": p("inventory", "استلام تحويل وارد", "Receive an incoming transfer"),
  "inventory.location.manage": p("inventory", "إدارة المستودعات والرفوف والصناديق", "Manage warehouses, shelves and bins"),
  "inventory.serial.read": p("inventory", "عرض الأرقام التسلسلية وحالتها", "View serial numbers and their status"),
  "inventory.serial.manage": p("inventory", "تسجيل الأرقام التسلسلية وتعديل حالتها", "Register serial numbers and change their status"),
  "inventory.reservation.release": p("inventory", "تحرير حجز مخزون يدوياً", "Release a stock reservation manually"),
  "inventory.oversell.authorize": p("inventory", "السماح ببيع صنف برصيد سالب مع ذكر السبب", "Authorize selling an item into negative stock, with a reason"),
  "inventory.reorder.manage": p("inventory", "ضبط حدود إعادة الطلب", "Set reorder points"),
  "inventory.report.read": p("inventory", "عرض تقارير المخزون الراكد والدوران", "View slow-stock and turnover reports"),

  // ── 05 orders
  "orders.order.read": p("orders", "عرض الطلبات وتفاصيلها", "View orders and their details"),
  "orders.order.create": p("orders", "إنشاء طلب نيابة عن العميل", "Create an order on a customer's behalf"),
  "orders.order.update": p("orders", "تعديل الطلب قبل الشحن", "Edit an order before it ships"),
  "orders.order.cancel": p("orders", "إلغاء طلب", "Cancel an order"),
  "orders.order.assign": p("orders", "تخصيص موظف لتجهيز الطلب", "Assign an order to a staff member"),
  "orders.order.note": p("orders", "إضافة ملاحظة داخلية على الطلب", "Add an internal note to an order"),
  "orders.order.export": p("orders", "تصدير الطلبات", "Export orders"),
  "orders.payment.verify": p("orders", "مطابقة إثبات التحويل واعتماد الدفع أو رفضه", "Review a transfer proof and approve or reject the payment"),
  "orders.payment.record": p("orders", "تسجيل تحصيل الدفع عند الاستلام", "Record a cash-on-delivery collection"),
  "orders.refund.create": p("orders", "طلب استرداد مبلغ", "Request a refund"),
  "orders.refund.approve": p("orders", "اعتماد الاسترداد وتنفيذه", "Approve and issue a refund"),
  "orders.fulfillment.pack": p("orders", "تجهيز الطلب ومسح الأصناف والأرقام التسلسلية", "Pack an order and scan its items and serials"),
  "orders.fulfillment.ship": p("orders", "تسليم الطلب لشركة الشحن وتسجيل رقم التتبع", "Hand an order to the carrier and record tracking"),
  "orders.fulfillment.deliver": p("orders", "تأكيد التسليم وإثبات الاستلام", "Confirm delivery and proof of receipt"),
  "orders.document.print": p("orders", "طباعة الفواتير وملصقات الشحن", "Print invoices and shipping labels"),
  "orders.preorder.manage": p("orders", "إدارة الطلبات المسبقة ومواعيدها", "Manage preorders and their dates"),
  "orders.risk.review": p("orders", "مراجعة الطلبات المشبوهة أو المتأخرة", "Review suspicious or late orders"),

  // ── 06 pos
  "pos.sale.create": p("pos", "البيع من نقطة البيع", "Sell at the point of sale"),
  "pos.sale.refund": p("pos", "إرجاع عملية بيع من نقطة البيع", "Refund a point-of-sale sale"),
  "pos.discount.apply": p("pos", "تطبيق خصم ضمن حد الكاشير", "Apply a discount within the cashier limit"),
  "pos.shift.open": p("pos", "فتح وردية ودرج النقد", "Open a shift and cash drawer"),
  "pos.shift.close": p("pos", "إغلاق الوردية وجرد النقد", "Close a shift and count the cash"),
  "pos.shift.review": p("pos", "مراجعة فروقات الورديات واعتمادها", "Review and approve shift variances"),
  "pos.cash.move": p("pos", "تسجيل إيداع أو سحب من درج النقد", "Record cash paid into or out of the drawer"),
  "pos.receipt.reprint": p("pos", "إعادة طباعة إيصال", "Reprint a receipt"),
  "pos.register.manage": p("pos", "إدارة أجهزة نقاط البيع", "Manage POS registers"),

  // ── 07 customers
  "customers.customer.read": p("customers", "عرض ملفات العملاء", "View customer profiles"),
  "customers.customer.update": p("customers", "تعديل بيانات العميل وعناوينه", "Edit customer details and addresses"),
  "customers.customer.note": p("customers", "إضافة ملاحظات داخلية على العميل", "Add internal notes to a customer"),
  "customers.customer.merge": p("customers", "دمج الحسابات المكررة", "Merge duplicate accounts"),
  "customers.customer.block": p("customers", "حظر عميل أو وسمه بمخاطر احتيال", "Block a customer or flag a fraud risk"),
  "customers.customer.export": p("customers", "تصدير بيانات العملاء", "Export customer data"),
  "customers.segment.manage": p("customers", "إدارة شرائح العملاء", "Manage customer segments"),
  "customers.consent.read": p("customers", "عرض سجل الموافقات التسويقية", "View the consent history"),
  "customers.privacy.manage": p("customers", "معالجة طلبات الخصوصية والتصدير والحذف", "Handle privacy, export and deletion requests"),
  "customers.wallet.read": p("customers", "عرض رصيد المحفظة وحركاتها", "View wallet balance and ledger"),
  "customers.wallet.adjust": p("customers", "إضافة تسوية يدوية على محفظة العميل", "Post a manual wallet adjustment"),
  "customers.communication.read": p("customers", "عرض سجل التواصل مع العميل", "View the communication log"),

  // ── 08 promotions
  "promotions.promotion.read": p("promotions", "عرض العروض والكوبونات", "View promotions and coupons"),
  "promotions.coupon.manage": p("promotions", "إدارة الكوبونات", "Manage coupons"),
  "promotions.rule.manage": p("promotions", "إدارة قواعد الخصم الشرطية", "Manage conditional discount rules"),
  "promotions.flash_sale.manage": p("promotions", "إدارة عروض الوقت المحدود", "Manage flash sales"),
  "promotions.loyalty.manage": p("promotions", "إدارة برنامج النقاط", "Manage the loyalty programme"),
  "promotions.loyalty.adjust": p("promotions", "تسوية نقاط عميل يدوياً", "Adjust a customer's points manually"),
  "promotions.referral.manage": p("promotions", "إدارة رموز الإحالة", "Manage referral codes"),
  "promotions.membership.manage": p("promotions", "إدارة العضويات ومزاياها", "Manage memberships and their benefits"),
  "promotions.gift_card.issue": p("promotions", "إصدار بطاقة هدية", "Issue a gift card"),
  "promotions.gift_card.manage": p("promotions", "إدارة بطاقات الهدايا وإيقافها", "Manage and void gift cards"),
  "promotions.experiment.manage": p("promotions", "إدارة تجارب العروض", "Manage promotion experiments"),

  // ── 09 purchasing
  "purchasing.supplier.read": p("purchasing", "عرض الموردين", "View suppliers"),
  "purchasing.supplier.manage": p("purchasing", "إدارة ملفات الموردين", "Manage supplier profiles"),
  "purchasing.supplier.rate": p("purchasing", "تقييم أداء المورد", "Rate supplier performance"),
  "purchasing.rfq.manage": p("purchasing", "إدارة طلبات عروض الأسعار", "Manage requests for quotation"),
  "purchasing.po.read": p("purchasing", "عرض أوامر الشراء", "View purchase orders"),
  "purchasing.po.create": p("purchasing", "إنشاء أمر شراء", "Create a purchase order"),
  "purchasing.po.approve": p("purchasing", "اعتماد أمر شراء", "Approve a purchase order"),
  "purchasing.receipt.create": p("purchasing", "تسجيل استلام بضاعة أمر الشراء", "Record goods received against a purchase order"),
  "purchasing.invoice.manage": p("purchasing", "مطابقة فواتير الموردين", "Match supplier invoices"),
  "purchasing.landed_cost.allocate": p("purchasing", "توزيع تكاليف الشحن والجمارك على الوحدات", "Allocate freight and customs to units"),
  "purchasing.claim.manage": p("purchasing", "إدارة مطالبات النقص والتالف والإرجاع للمورد", "Manage shortage, damage and return claims"),

  // ── 10 finance
  "finance.journal.read": p("finance", "عرض دفتر القيود", "View the journal"),
  "finance.journal.post": p("finance", "ترحيل قيد يدوي أو قيد عكسي", "Post a manual or reversing journal entry"),
  "finance.account.manage": p("finance", "إدارة دليل الحسابات", "Manage the chart of accounts"),
  "finance.period.close": p("finance", "إغلاق الفترة المالية", "Close a fiscal period"),
  "finance.settlement.reconcile": p("finance", "مطابقة تسويات الدفع وكشوف الحساب", "Reconcile payment settlements and statements"),
  "finance.expense.manage": p("finance", "تسجيل المصروفات ومراكز التكلفة", "Record expenses and cost centres"),
  "finance.report.read": p("finance", "عرض تقارير الأرباح والخسائر والتدفق النقدي", "View profit-and-loss and cash-flow reports"),
  "finance.wallet.read": p("finance", "عرض دفتر محافظ العملاء", "View the customer wallet ledger"),
  "finance.tax.manage": p("finance", "ضبط إعدادات الضريبة وتقاريرها", "Configure taxes and tax reports"),
  "finance.anomaly.read": p("finance", "عرض تحذيرات القيم الشاذة وعدم التطابق", "View anomaly and mismatch warnings"),

  // ── 11 shipping
  "shipping.zone.manage": p("shipping", "إدارة المحافظات والمناطق وتوفر التوصيل", "Manage governorates, districts and delivery availability"),
  "shipping.rate.manage": p("shipping", "تعديل رسوم التوصيل", "Edit delivery fees"),
  "shipping.carrier.manage": p("shipping", "إدارة شركات الشحن", "Manage carriers"),
  "shipping.shipment.read": p("shipping", "عرض الشحنات", "View shipments"),
  "shipping.shipment.create": p("shipping", "إنشاء شحنة ورقم تتبع", "Create a shipment and tracking number"),
  "shipping.shipment.update": p("shipping", "تحديث حالة الشحنة", "Update shipment status"),
  "shipping.attempt.manage": p("shipping", "معالجة فشل التسليم وإعادة المحاولة", "Handle failed deliveries and retries"),
  "shipping.proof.manage": p("shipping", "رفع إثبات الاستلام وصور التغليف", "Upload delivery proof and packing photos"),
  "shipping.cod.settle": p("shipping", "تسوية مبالغ الدفع عند الاستلام مع شركات الشحن", "Settle cash-on-delivery amounts with carriers"),

  // ── 12 returns
  "returns.rma.read": p("returns", "عرض طلبات الإرجاع", "View return requests"),
  "returns.rma.create": p("returns", "إنشاء طلب إرجاع", "Create a return request"),
  "returns.rma.approve": p("returns", "قبول طلب الإرجاع أو رفضه", "Approve or reject a return request"),
  "returns.rma.inspect": p("returns", "فحص المنتج المرتجع وتصنيف حالته", "Inspect and grade a returned item"),
  "returns.policy.manage": p("returns", "ضبط قواعد أهلية الإرجاع", "Configure return eligibility rules"),
  "returns.warranty.read": p("returns", "عرض الضمانات", "View warranties"),
  "returns.warranty.manage": p("returns", "تعديل الضمانات وتمديدها أو إلغاؤها", "Edit, extend or void warranties"),
  "returns.repair.manage": p("returns", "إدارة تذاكر الصيانة وقطع الغيار", "Manage repair tickets and parts"),
  "returns.supplier_return.manage": p("returns", "إدارة الإرجاع إلى المورد", "Manage returns to suppliers"),

  // ── 13 devices
  "devices.registry.read": p("devices", "عرض سجل الأجهزة بالأرقام التسلسلية", "View the device registry by serial number"),
  "devices.used.intake": p("devices", "استلام جهاز مستعمل وتسجيله", "Take in and register a used device"),
  "devices.used.inspect": p("devices", "تنفيذ فحص الجهاز المستعمل", "Run the used-device inspection"),
  "devices.used.grade": p("devices", "تحديد درجة حالة الجهاز المستعمل", "Grade a used device"),
  "devices.used.list": p("devices", "عرض الجهاز المستعمل للبيع أو سحبه", "List or unlist a used device for sale"),
  "devices.ownership.verify": p("devices", "تأكيد الملكية وفصل الحسابات ومسح البيانات", "Confirm ownership, account removal and data wipe"),
  "devices.tradein.read": p("devices", "عرض طلبات المقايضة", "View trade-in requests"),
  "devices.tradein.inspect": p("devices", "فحص جهاز المقايضة", "Inspect a trade-in device"),
  "devices.tradein.offer": p("devices", "إصدار عرض السعر النهائي للمقايضة", "Issue the final trade-in offer"),
  "devices.tradein.payout": p("devices", "صرف قيمة المقايضة رصيداً أو نقداً", "Pay out a trade-in as store credit or cash"),
  "devices.price_guide.manage": p("devices", "إدارة أسعار المقايضة المرجعية", "Manage trade-in price guides"),
  "devices.inspection_template.manage": p("devices", "تعديل قوائم فحص الأجهزة", "Edit inspection checklists"),
  "devices.digital_code.manage": p("devices", "إدخال الرموز الرقمية وإدارتها", "Import and manage digital codes"),

  // ── 14 support
  "support.ticket.read": p("support", "عرض التذاكر", "View tickets"),
  "support.ticket.reply": p("support", "الرد على التذاكر", "Reply to tickets"),
  "support.ticket.assign": p("support", "توزيع التذاكر على الموظفين", "Assign tickets"),
  "support.ticket.close": p("support", "إغلاق التذاكر", "Close tickets"),
  "support.ticket.escalate": p("support", "تصعيد شكوى مالية أو شكوى ضمان", "Escalate a financial or warranty complaint"),
  "support.canned_reply.manage": p("support", "إدارة الردود الجاهزة", "Manage canned replies"),
  "support.routing.manage": p("support", "ضبط قواعد توجيه التذاكر", "Configure ticket routing rules"),
  "support.knowledge.manage": p("support", "كتابة مقالات قاعدة المعرفة وتعديلها", "Write and edit knowledge articles"),
  "support.knowledge.approve": p("support", "اعتماد مقالات المعرفة وأشجار التشخيص", "Approve knowledge articles and troubleshooting trees"),
  "support.assistant.review": p("support", "مراجعة محادثات مساعد الصيانة", "Review maintenance-assistant conversations"),
  "support.metrics.read": p("support", "عرض مؤشرات خدمة العملاء", "View service metrics"),

  // ── 15 staff
  "staff.manage": p("staff", "إدارة الموظفين والأدوار والصلاحيات", "Manage employees, roles and permissions"),
  "staff.employee.read": p("staff", "عرض قائمة الموظفين", "View the employee list"),
  "staff.schedule.manage": p("staff", "إدارة جداول الدوام والورديات", "Manage schedules and shifts"),
  "staff.attendance.manage": p("staff", "تعديل سجلات الحضور واعتمادها", "Edit and approve attendance records"),
  "staff.leave.approve": p("staff", "اعتماد طلبات الإجازة", "Approve leave requests"),
  "staff.task.manage": p("staff", "إسناد المهام للموظفين", "Assign tasks to staff"),
  "staff.commission.manage": p("staff", "إدارة قواعد العمولات", "Manage commission rules"),
  "staff.payroll.read": p("staff", "عرض الرواتب والسلف", "View salaries and advances"),
  "staff.payroll.run": p("staff", "إعداد مسير الرواتب", "Prepare a payroll run"),
  "staff.payroll.approve": p("staff", "اعتماد مسير الرواتب وصرفه", "Approve and pay a payroll run"),
  "staff.performance.read": p("staff", "عرض لوحة أداء الموظفين", "View staff performance"),
  "staff.approval.read": p("staff", "عرض طلبات الموافقة المعلقة", "View pending approval requests"),

  // ── 16 marketing
  "marketing.campaign.manage": p("marketing", "إعداد حملات البريد والرسائل", "Prepare email and message campaigns"),
  "marketing.campaign.send": p("marketing", "إرسال حملة لمن وافق على التسويق", "Send a campaign to customers who consented"),
  "marketing.cart_recovery.manage": p("marketing", "إدارة تذكير السلال المتروكة", "Manage abandoned-cart reminders"),
  "marketing.utm.manage": p("marketing", "إدارة روابط الحملات", "Manage campaign links"),
  "marketing.recommendation.manage": p("marketing", "إدارة قواعد التوصيات: تثبيت واستبعاد وأولوية", "Manage recommendation rules: pin, exclude and boost"),
  "marketing.review.moderate": p("marketing", "مراجعة تقييمات العملاء", "Moderate customer reviews"),
  "marketing.experiment.manage": p("marketing", "إدارة تجارب المتجر", "Manage storefront experiments"),
  "marketing.report.read": p("marketing", "عرض تقارير التسويق", "View marketing reports"),

  // ── 17 cms
  "cms.banner.manage": p("cms", "إدارة البانرات", "Manage banners"),
  "cms.home.manage": p("cms", "ترتيب أقسام الصفحة الرئيسية", "Arrange home page sections"),
  "cms.page.manage": p("cms", "تعديل الصفحات والسياسات", "Edit pages and policies"),
  "cms.page.publish": p("cms", "نشر الصفحات وجدولتها", "Publish and schedule pages"),
  "cms.navigation.manage": p("cms", "إدارة قوائم التصفح والفلاتر", "Manage navigation menus and filters"),
  "cms.seo.manage": p("cms", "تعديل عناوين محركات البحث وأوصافها", "Edit SEO titles and descriptions"),
  "cms.redirect.manage": p("cms", "إدارة تحويلات الروابط", "Manage URL redirects"),
  "cms.search.manage": p("cms", "إدارة مرادفات البحث وعمليات البحث بلا نتائج", "Manage search synonyms and no-result searches"),
  "cms.device_hub.manage": p("cms", "تعديل محتوى صفحات الأجهزة", "Edit device hub content"),
  "cms.media.moderate": p("cms", "مراجعة الصور المرفوعة", "Moderate uploaded media"),
  "cms.motion.manage": p("cms", "ضبط تجارب الحركة والأداء", "Tune motion and performance experiments"),

  // ── 18 reports
  "reports.sales.read": p("reports", "عرض تقارير المبيعات", "View sales reports"),
  "reports.margin.read": p("reports", "عرض تقارير صافي الهامش", "View net-margin reports"),
  "reports.inventory.read": p("reports", "عرض تحليل ABC ودوران المخزون", "View ABC and stock-turnover analysis"),
  "reports.customer.read": p("reports", "عرض تحليل شرائح العملاء وتكرار الشراء", "View cohort and repeat-purchase analysis"),
  "reports.performance.read": p("reports", "عرض أداء الموردين والموظفين والشحن والدعم", "View supplier, staff, shipping and support performance"),
  "reports.saved.manage": p("reports", "حفظ التقارير وجدولة إرسالها", "Save reports and schedule their delivery"),
  "reports.export.create": p("reports", "تصدير التقارير بصيغة CSV أو XLSX", "Export reports as CSV or XLSX"),
  "reports.dictionary.manage": p("reports", "تعديل قاموس المقاييس", "Edit the metrics dictionary"),

  // ── 19 automation
  "automation.workflow.read": p("automation", "عرض قواعد الأتمتة وسجل تنفيذها", "View automation rules and their run log"),
  "automation.workflow.manage": p("automation", "إنشاء قواعد الأتمتة وتعديلها", "Create and edit automation rules"),
  "automation.workflow.activate": p("automation", "تفعيل قاعدة بعد تشغيلها التجريبي", "Activate a rule after its dry run"),
  "automation.suggestion.read": p("automation", "عرض اقتراحات إعادة الطلب والتوقعات", "View reorder suggestions and forecasts"),
  "automation.suggestion.approve": p("automation", "اعتماد اقتراح آلي", "Approve an automated suggestion"),
  "automation.assistant.use": p("automation", "استخدام المساعد الإداري", "Use the admin assistant"),
  "automation.anomaly.read": p("automation", "عرض المعاملات غير المعتادة", "View unusual transactions"),

  // ── 20 security
  "audit.read": p("security", "عرض سجل التدقيق", "View the audit log"),
  "security.audit.verify": p("security", "ختم سجل التدقيق والتحقق من سلامته", "Seal the audit log and verify its integrity"),
  "security.session.read": p("security", "عرض جلسات الموظفين", "View employee sessions"),
  "security.session.revoke": p("security", "إنهاء جلسات الموظفين", "Revoke employee sessions"),
  "security.mfa.manage": p("security", "إعادة ضبط التحقق بخطوتين لموظف", "Reset an employee's two-step verification"),
  "security.auth_event.read": p("security", "عرض محاولات الدخول والتنبيهات", "View sign-in attempts and alerts"),
  "security.backup.manage": p("security", "إدارة النسخ الاحتياطية واختبارات الاستعادة", "Manage backups and restore tests"),
  "security.retention.manage": p("security", "ضبط سياسة الاحتفاظ بالبيانات وحذفها", "Configure data retention and deletion"),
  "security.access_review.perform": p("security", "تنفيذ المراجعة الدورية للصلاحيات", "Run periodic access reviews"),
  "security.fraud.review": p("security", "مراجعة تنبيهات الاحتيال والاستردادات", "Review fraud alerts and refunds"),

  // ── 21 channels
  "channels.branch.manage": p("channels", "إدارة الفروع", "Manage branches"),
  "channels.channel.manage": p("channels", "إدارة قنوات البيع", "Manage sales channels"),
  "channels.api_key.manage": p("channels", "إدارة مفاتيح API", "Manage API keys"),
  "channels.webhook.manage": p("channels", "إدارة إشعارات Webhook", "Manage webhooks"),
  "channels.integration.read": p("channels", "مراقبة حالة التكاملات", "Monitor integration status"),
  "channels.integration.manage": p("channels", "ربط مزودي الدفع والشحن والرسائل", "Connect payment, shipping and messaging providers"),
  "channels.report.read": p("channels", "عرض ربحية القنوات", "View channel profitability"),

  // ── 22 settings
  "settings.read": p("settings", "عرض إعدادات النظام", "View system settings"),
  "settings.manage": p("settings", "تعديل إعدادات النظام", "Change system settings"),
  "settings.payment.manage": p("settings", "تعديل طرق الدفع وبيانات حسابات التحويل", "Change payment methods and transfer account details"),
  "settings.shipping.manage": p("settings", "تعديل رسم الشحن وتفعيل الاستثناءات", "Change the shipping fee and enable overrides"),
  "settings.custom_field.manage": p("settings", "إدارة الحقول المخصصة وقواعد التحقق", "Manage custom fields and validation rules"),
  "settings.template.manage": p("settings", "تعديل قوالب الرسائل والفواتير", "Edit message and invoice templates"),
  "settings.file.manage": p("settings", "إدارة الملفات المرفوعة", "Manage uploaded files"),
  "settings.locale.manage": p("settings", "ضبط اللغة والتوقيت وأنظمة الأرقام", "Configure language, time zone and numerals"),
  "settings.change.approve": p("settings", "اعتماد تغييرات الإعدادات المعلقة", "Approve pending settings changes"),

  // ── 23 ops
  "ops.error.read": p("ops", "عرض أخطاء الواجهة والخادم", "View front-end and server errors"),
  "ops.error.resolve": p("ops", "معالجة الأخطاء وإغلاقها", "Resolve and close errors"),
  "ops.performance.read": p("ops", "عرض مقاييس الأداء", "View performance metrics"),
  "ops.job.read": p("ops", "عرض مهام الخلفية وطابور الرسائل", "View background jobs and the message queue"),
  "ops.job.run": p("ops", "تشغيل مهمة خلفية يدوياً", "Run a background job manually"),
  "ops.backup.read": p("ops", "مراقبة النسخ الاحتياطية", "Monitor backups"),
  "ops.incident.read": p("ops", "عرض الحوادث", "View incidents"),
  "ops.incident.manage": p("ops", "إدارة الحوادث وتحديثاتها", "Manage incidents and their updates"),
  "ops.consistency.read": p("ops", "عرض نتائج فحوصات الاتساق اليومية", "View daily consistency-check results"),
  "ops.consistency.resolve": p("ops", "معالجة نتائج فحوصات الاتساق", "Resolve consistency findings"),

  // ── field-level: whether protected data may leave the server at all
  "cost.read": p("fields", "رؤية تكلفة الشراء والتكلفة الواصلة", "See purchase cost and landed cost"),
  "profit.read": p("fields", "رؤية الربح والهامش", "See profit and margin"),
  "customer.phone.read_full": p("fields", "رؤية رقم هاتف العميل كاملاً", "See customers' full phone numbers"),
  "payment_proof.read": p("fields", "فتح صور إثبات التحويل", "Open transfer-proof images"),
  "digital_code.reveal": p("fields", "كشف الرمز الرقمي", "Reveal a digital code"),
} as const satisfies Record<string, Def>;

export type Permission = keyof typeof PERMISSION_DEFS;

/** Every permission, in catalogue order. */
export const PERMISSIONS = Object.keys(PERMISSION_DEFS) as Permission[];

/** The owner role's single stored permission: everything, including permissions added later. */
export const WILDCARD_PERMISSION = "*";

/** Field-level permissions: holders see protected data; for everyone else it is absent from responses. */
export const FIELD_PERMISSIONS = ["cost.read", "profit.read", "customer.phone.read_full", "payment_proof.read", "digital_code.reveal"] as const satisfies readonly Permission[];

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(PERMISSION_DEFS, value);
}

export type PermissionInfo = { key: Permission; group: PermissionGroupKey; label: L10n };

export function permissionInfo(key: Permission): PermissionInfo {
  const def = PERMISSION_DEFS[key];
  return { key, group: def.group, label: { ar: def.ar, en: def.en } };
}

export type PermissionGroup = { key: PermissionGroupKey; module: string | null; label: L10n; permissions: PermissionInfo[] };

/** The catalogue grouped by module, in blueprint order — what a role editor renders. */
export function permissionGroups(): PermissionGroup[] {
  return PERMISSION_GROUPS.map((group) => ({
    key: group.key,
    module: group.module,
    label: { ar: group.ar, en: group.en },
    permissions: PERMISSIONS.filter((key) => PERMISSION_DEFS[key].group === group.key).map(permissionInfo),
  }));
}

/**
 * The concrete permissions behind a stored list: unknown strings are dropped and the wildcard
 * becomes the whole catalogue.
 */
export function expandPermissions(stored: Iterable<string>): Set<Permission> {
  const out = new Set<Permission>();
  for (const value of stored) {
    if (value === WILDCARD_PERMISSION) return new Set(PERMISSIONS);
    if (isPermission(value)) out.add(value);
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── default roles

export const DEFAULT_ROLE_KEYS = ["owner", "manager", "finance", "inventory", "fulfillment", "support", "cashier", "content"] as const;
export type DefaultRoleKey = (typeof DEFAULT_ROLE_KEYS)[number];

export type DefaultRole = {
  key: DefaultRoleKey;
  name: L10n;
  description: L10n;
  /** What seedRoles() stores in role_permissions. */
  permissions: readonly (Permission | typeof WILDCARD_PERMISSION)[];
};

const inGroup = (...groups: PermissionGroupKey[]): Permission[] => PERMISSIONS.filter((key) => groups.includes(PERMISSION_DEFS[key].group));

/** Every role may open the admin and search; what they find is filtered by their other permissions. */
const BASE: Permission[] = ["dashboard.overview.read", "dashboard.search.use"];

/**
 * What a store manager does NOT get: anything that changes who may do what, where money is sent,
 * how the books are closed, or how the system is connected to the outside. Those stay with the owner
 * (and, for the books, with finance).
 */
const MANAGER_EXCLUDED: ReadonlySet<Permission> = new Set<Permission>([
  "staff.manage",
  "staff.payroll.approve",
  "settings.payment.manage",
  "settings.change.approve",
  "finance.journal.post",
  "finance.account.manage",
  "finance.period.close",
  "security.mfa.manage",
  "security.backup.manage",
  "security.retention.manage",
  "security.access_review.perform",
  "channels.api_key.manage",
  "channels.webhook.manage",
  "channels.integration.manage",
]);

const FINANCE: Permission[] = [
  ...BASE,
  "dashboard.sales.read",
  "dashboard.alerts.read",
  "dashboard.activity.read",
  ...inGroup("finance"),
  "cost.read",
  "profit.read",
  "payment_proof.read",
  "orders.order.read",
  "orders.order.export",
  "orders.payment.verify",
  "orders.payment.record",
  "orders.refund.create",
  "orders.refund.approve",
  "orders.risk.review",
  "orders.document.print",
  "pricing.cost.update",
  "pricing.margin.manage",
  "pricing.simulation.run",
  "pricing.suggestion.read",
  "pricing.fx_rate.manage",
  "purchasing.supplier.read",
  "purchasing.po.read",
  "purchasing.invoice.manage",
  "purchasing.landed_cost.allocate",
  "inventory.stock.read",
  "inventory.movement.read",
  "inventory.report.read",
  "shipping.shipment.read",
  "shipping.cod.settle",
  "pos.shift.review",
  "customers.customer.read",
  "customers.wallet.read",
  "customers.wallet.adjust",
  "promotions.promotion.read",
  "returns.rma.read",
  "staff.employee.read",
  "staff.commission.manage",
  "staff.payroll.read",
  "staff.payroll.run",
  "staff.approval.read",
  "reports.sales.read",
  "reports.margin.read",
  "reports.inventory.read",
  "reports.customer.read",
  "reports.performance.read",
  "reports.saved.manage",
  "reports.export.create",
  "marketing.report.read",
  "channels.report.read",
  "automation.anomaly.read",
  "security.fraud.review",
  "audit.read",
  "settings.read",
  "ops.consistency.read",
];

const INVENTORY: Permission[] = [
  ...BASE,
  "dashboard.alerts.read",
  "inventory.stock.read",
  "inventory.stock.adjust",
  "inventory.stock.receive",
  "inventory.movement.read",
  "inventory.count.perform",
  "inventory.transfer.create",
  "inventory.transfer.receive",
  "inventory.location.manage",
  "inventory.serial.read",
  "inventory.serial.manage",
  "inventory.reservation.release",
  "inventory.reorder.manage",
  "inventory.report.read",
  "catalog.product.read",
  "purchasing.po.read",
  "purchasing.receipt.create",
  "orders.order.read",
  "orders.fulfillment.pack",
  "shipping.shipment.read",
  "returns.rma.read",
  "returns.rma.inspect",
  "devices.registry.read",
  "devices.used.intake",
  "devices.used.inspect",
  "devices.used.grade",
  "automation.suggestion.read",
];

const FULFILLMENT: Permission[] = [
  ...BASE,
  "dashboard.alerts.read",
  "orders.order.read",
  "orders.order.note",
  "orders.fulfillment.pack",
  "orders.fulfillment.ship",
  "orders.fulfillment.deliver",
  "orders.document.print",
  "inventory.stock.read",
  "inventory.serial.read",
  "shipping.shipment.read",
  "shipping.shipment.create",
  "shipping.shipment.update",
  "shipping.attempt.manage",
  "shipping.proof.manage",
  "returns.rma.read",
  // Shipping labels and delivery calls need the real number.
  "customer.phone.read_full",
];

const SUPPORT: Permission[] = [
  ...BASE,
  "dashboard.alerts.read",
  "support.ticket.read",
  "support.ticket.reply",
  "support.ticket.assign",
  "support.ticket.close",
  "support.ticket.escalate",
  "support.canned_reply.manage",
  "support.knowledge.manage",
  "support.assistant.review",
  "support.metrics.read",
  "orders.order.read",
  "orders.order.note",
  "orders.refund.create",
  "customers.customer.read",
  "customers.customer.note",
  "customers.consent.read",
  "customers.communication.read",
  "returns.rma.read",
  "returns.rma.create",
  "returns.warranty.read",
  "returns.repair.manage",
  "shipping.shipment.read",
  "devices.tradein.read",
  "catalog.product.read",
  "inventory.stock.read",
  // Support calls customers back.
  "customer.phone.read_full",
];

const CASHIER: Permission[] = [
  ...BASE,
  "pos.sale.create",
  "pos.discount.apply",
  "pos.shift.open",
  "pos.shift.close",
  "pos.cash.move",
  "pos.receipt.reprint",
  "catalog.product.read",
  "inventory.stock.read",
  "inventory.serial.read",
  "customers.customer.read",
  "returns.warranty.read",
  "returns.rma.create",
];

const CONTENT: Permission[] = [
  ...BASE,
  ...inGroup("cms"),
  "catalog.product.read",
  "catalog.product.create",
  "catalog.product.update",
  "catalog.category.manage",
  "catalog.media.manage",
  "catalog.compatibility.manage",
  "catalog.bundle.manage",
  "catalog.relation.manage",
  "support.knowledge.manage",
  "marketing.review.moderate",
];

/**
 * Built-in roles, least privilege first in mind: only owner, manager and finance see cost and profit;
 * only owner changes roles, payment destinations and integrations. Staff can be given several roles,
 * and the owner can edit every role except their own wildcard.
 */
export const DEFAULT_ROLES: readonly DefaultRole[] = [
  {
    key: "owner",
    name: { ar: "المالك", en: "Owner", ckb: "خاوەن" },
    description: { ar: "كل الصلاحيات، بما فيها الأدوار وحسابات الدفع والتكاملات.", en: "Everything, including roles, payment accounts and integrations." },
    permissions: [WILDCARD_PERMISSION],
  },
  {
    key: "manager",
    name: { ar: "مدير المتجر", en: "Store manager", ckb: "بەڕێوەبەری فرۆشگا" },
    description: { ar: "تشغيل المتجر كاملاً مع رؤية التكلفة والربح، دون تعديل الأدوار أو حسابات الدفع أو إغلاق الدفاتر.", en: "Runs the whole store and sees cost and profit, without changing roles, payment accounts or closing the books." },
    permissions: PERMISSIONS.filter((key) => !MANAGER_EXCLUDED.has(key)),
  },
  {
    key: "finance",
    name: { ar: "المالية", en: "Finance", ckb: "دارایی" },
    description: { ar: "الدفاتر والتسويات ومطابقة التحويلات والاستردادات والرواتب.", en: "Books, settlements, transfer verification, refunds and payroll." },
    permissions: FINANCE,
  },
  {
    key: "inventory",
    name: { ar: "المخزن", en: "Inventory", ckb: "کۆگا" },
    description: { ar: "الاستلام والجرد والتحويلات والأرقام التسلسلية وفحص المستعمل، دون رؤية التكلفة.", en: "Receiving, counts, transfers, serials and used-device inspection, without seeing cost." },
    permissions: INVENTORY,
  },
  {
    key: "fulfillment",
    name: { ar: "التجهيز والشحن", en: "Fulfillment", ckb: "ئامادەکردن و ناردن" },
    description: { ar: "تجهيز الطلبات وتسليمها لشركة الشحن ومتابعة التسليم.", en: "Packs orders, hands them to the carrier and follows delivery." },
    permissions: FULFILLMENT,
  },
  {
    key: "support",
    name: { ar: "خدمة العملاء", en: "Support", ckb: "خزمەتگوزاریی کڕیاران" },
    description: { ar: "التذاكر والإرجاع والصيانة والتواصل مع العملاء.", en: "Tickets, returns, repairs and contact with customers." },
    permissions: SUPPORT,
  },
  {
    key: "cashier",
    name: { ar: "الكاشير", en: "Cashier", ckb: "کاشێر" },
    description: { ar: "البيع من نقطة البيع وفتح الوردية وإغلاقها.", en: "Sells at the point of sale and opens and closes the shift." },
    permissions: CASHIER,
  },
  {
    key: "content",
    name: { ar: "المحتوى", en: "Content", ckb: "ناوەڕۆک" },
    description: { ar: "صفحات المتجر والبانرات وبيانات المنتجات وصورها، دون نشر المنتج أو تغيير سعره.", en: "Store pages, banners, product details and images, without publishing products or changing prices." },
    permissions: CONTENT,
  },
];

/** Stable ids for the built-in roles, so seeding is idempotent. */
export const roleId = (key: DefaultRoleKey) => `role_${key}`;

/** The concrete permission set of a built-in role (the wildcard expanded). */
export function defaultRolePermissions(key: DefaultRoleKey): Set<Permission> {
  const role = DEFAULT_ROLES.find((entry) => entry.key === key);
  if (!role) throw new Error(`Unknown default role "${key}"`);
  return expandPermissions(role.permissions);
}
