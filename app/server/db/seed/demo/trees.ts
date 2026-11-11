/**
 * DEMO troubleshooting trees (guided diagnosis for the maintenance assistant):
 *
 *   stick_drift   "Controller stick drift"
 *   no_power      "Console does not power on"
 *
 * Both apply to any device (no model, no platform). Every path ends in an outcome that is safe:
 * "resolved", a link to an approved article with device-specific safe steps, or "book a repair".
 * No path tells the shopper to open a device, and the no-power tree asks about danger signs first.
 * Outcomes say "most likely" — a description alone never yields a definitive hardware diagnosis.
 */
import type { TroubleshootingNode, TroubleshootingTree } from "../../schema";
import { STICK_DRIFT_TREE_TITLE } from "./knowledge";
import { same, t3, type T3 } from "./text";

export type TreeSeed = { symptomKey: string; title: T3; tree: TroubleshootingTree };

const option = (label: T3, next: string) => ({ label, next });

const question = (id: string, text: T3, options: Array<{ label: T3; next: string }>): TroubleshootingNode => ({ id, kind: "question", text, options });

const stepNode = (id: string, text: T3, options: Array<{ label: T3; next: string }>, warning?: T3): TroubleshootingNode => ({
  id,
  kind: "step",
  text,
  ...(warning ? { warning } : {}),
  options,
});

const outcome = (id: string, text: T3, result: NonNullable<TroubleshootingNode["outcome"]>, warning?: T3): TroubleshootingNode => ({
  id,
  kind: "outcome",
  text,
  ...(warning ? { warning } : {}),
  outcome: result,
});

// ───────────────────────────────────────────────────────────────── stick drift

const STILL_DRIFTING = t3("جرّبت — ما زالت تنحرف", "Tried it — still drifting", "تاقیم کردەوە — هێشتا لادەدات");
const DRIFT_GONE = t3("اختفى الانحراف", "The drift is gone", "لادانەکە نەما");
const afterStep = (next: string) => [option(STILL_DRIFTING, next), option(DRIFT_GONE, "resolved")];

const STICK_DRIFT: TroubleshootingTree = {
  start: "clean",
  nodes: [
    stepNode(
      "clean",
      t3(
        "أطفئ اليد أو الجهاز. انفخ برفق حول قاعدة العصا وامسحها بقطعة قماش جافة، ثم حرّك العصا في دوائر كاملة عشر مرات واضغطها للداخل بضع مرات.",
        "Switch the controller or device off. Blow gently around the base of the stick and wipe it with a dry cloth, then move the stick in full circles ten times and click it in a few times.",
        "دەسکەکە یان ئامێرەکە بکوژێنەوە. بە نەرمی فوو بکە دەوری بنکەی جۆیستیکەکە و بە پارچە قوماشێکی وشک بیسڕە، پاشان دە جار جۆیستیکەکە بە بازنەی تەواو بجووڵێنە و چەند جارێک بەرەو ناوەوە دایبگرە.",
      ),
      afterStep("update"),
      t3(
        "لا تفتح اليد، ولا ترشّ سوائل أو بخاخات داخلها.",
        "Do not open the controller, and do not spray liquids or cleaners into it.",
        "دەسکەکە مەکەرەوە، و شلە یان سپرەی تێدا مەپڕژێنە.",
      ),
    ),
    stepNode(
      "update",
      t3(
        "حدّث برنامج اليد وبرنامج الجهاز، ثم أعد تشغيل الجهاز وأعد اقتران اليد.",
        "Update the controller and the console software, then restart the console and pair the controller again.",
        "نەرمەکاڵای دەسکەکە و ئامێرەکە نوێ بکەرەوە، پاشان ئامێرەکە دابگیرسێنەوە و دەسکەکە دووبارە جووت بکەرەوە.",
      ),
      afterStep("which"),
    ),
    question("which", t3("ما نوع يد التحكم؟", "Which controller is it?", "دەسکەکە چ جۆرێکە؟"), [
      option(t3("Nintendo (Joy-Con أو Pro Controller)", "Nintendo (Joy-Con or Pro Controller)", "Nintendo (Joy-Con یان Pro Controller)"), "calibrate_nintendo"),
      option(same("PlayStation (DualSense)"), "reset_dualsense"),
      option(same("Xbox"), "check_xbox"),
      option(t3("عصا مدمجة في حاسوب ألعاب محمول", "A built-in stick on a handheld gaming PC", "جۆیستیکی لکاو لە کۆمپیوتەری یاریی دەستی"), "calibrate_handheld"),
    ]),
    stepNode(
      "calibrate_nintendo",
      t3(
        "من إعدادات النظام افتح قسم أيدي التحكم واختر «معايرة عصا التحكم»، واتبع التعليمات على الشاشة.",
        "In System Settings, open the controllers section, choose “Calibrate Control Sticks” and follow the on-screen instructions.",
        "لە ڕێکخستنەکانی سیستەم بەشی دەسکەکان بکەرەوە، «پێوانەکردنەوەی جۆیستیک» هەڵبژێرە و ڕێنماییەکانی سەر شاشە جێبەجێ بکە.",
      ),
      afterStep("repair"),
    ),
    stepNode(
      "reset_dualsense",
      t3(
        "أطفئ جهاز PS5. اضغط زر إعادة الضبط داخل الثقب الصغير في ظهر اليد بدبوس مدة 5 ثوانٍ تقريباً، ثم صِل اليد بالجهاز بكيبل USB واضغط زر PS.",
        "Switch the PS5 off. With a pin, press the reset button inside the small hole on the back of the controller for about 5 seconds, then connect the controller to the console with a USB cable and press the PS button.",
        "PS5ـەکە بکوژێنەوە. بە دەرزییەک دوگمەی ڕێکخستنەوە لە ناو کونە بچووکەکەی پشتی دەسکەکە نزیکەی 5 چرکە داگرە، پاشان دەسکەکە بە کێبڵی USB بە ئامێرەکە ببەستە و دوگمەی PS داگرە.",
      ),
      afterStep("repair"),
    ),
    stepNode(
      "check_xbox",
      t3(
        "صِل اليد بالجهاز بكيبل USB-C وحدّثها من تطبيق «ملحقات Xbox»، ثم جرّبها سلكياً. إن اختفى الانحراف سلكياً فبدّل البطاريتين وأعد الاقتران.",
        "Connect the controller to the console with a USB-C cable and update it in the Xbox Accessories app, then try it wired. If the drift disappears when wired, replace the batteries and pair it again.",
        "دەسکەکە بە کێبڵی USB-C بە ئامێرەکە ببەستە و لە ئەپی «Xbox Accessories» نوێی بکەرەوە، پاشان بە وایەر تاقی بکەرەوە. ئەگەر لادانەکە بە وایەر نەما، پاترییەکان بگۆڕە و دووبارە جووتی بکەرەوە.",
      ),
      afterStep("repair"),
    ),
    stepNode(
      "calibrate_handheld",
      t3(
        "استخدم أداة معايرة العصا في إعدادات الجهاز أو تطبيق الشركة (إعدادات المتحكم في Steam Deck، Armoury Crate SE، Legion Space، MSI Center M)، وحدّث النظام.",
        "Use the stick calibration tool in the device settings or the maker's app (controller settings on Steam Deck, Armoury Crate SE, Legion Space, MSI Center M), and update the system.",
        "ئامرازی پێوانەکردنەوەی جۆیستیک لە ڕێکخستنەکانی ئامێرەکە یان ئەپی کۆمپانیاکە بەکاربهێنە (ڕێکخستنەکانی کۆنترۆڵەر لە Steam Deck، Armoury Crate SE، Legion Space، MSI Center M)، و سیستەم نوێ بکەرەوە.",
      ),
      afterStep("repair"),
    ),
    outcome(
      "resolved",
      t3(
        "جيد. إن عاد الانحراف خلال أيام فالأرجح أن وحدة العصا متآكلة وتحتاج استبدالاً لدى فني.",
        "Good. If the drift comes back within days, the stick module is most likely worn and needs replacing by a technician.",
        "باشە. ئەگەر لادانەکە لە ماوەی چەند ڕۆژێکدا گەڕایەوە، بە ئەگەری زۆر یەکەی جۆیستیکەکە داخوراوە و پێویستی بە گۆڕین هەیە لەلایەن تەکنیکارەوە.",
      ),
      { type: "resolved" },
    ),
    outcome(
      "repair",
      t3(
        "الانحراف الذي يبقى بعد التنظيف والتحديث والمعايرة سببه في الغالب تآكل وحدة العصا، ولا يمكن الجزم بذلك من الوصف وحده. استبدال الوحدة يحتاج فتح اليد ولحاماً دقيقاً، فلا تجرّبه في البيت. احجز صيانة ليفحصها الفني.",
        "Drift that remains after cleaning, updating and calibrating is usually caused by a worn stick module, though that cannot be confirmed from a description alone. Replacing the module means opening the controller and fine soldering, so do not attempt it at home. Book a repair so a technician can inspect it.",
        "ئەو لادانەی دوای پاککردنەوە و نوێکردنەوە و پێوانەکردنەوە دەمێنێتەوە، زۆربەی کات هۆکارەکەی داخورانی یەکەی جۆیستیکە، هەرچەندە تەنها لە وەسفەوە ناتوانرێت دڵنیا بکرێتەوە. گۆڕینی یەکەکە پێویستی بە کردنەوەی دەسکەکە و لەحیمکردنی ورد هەیە، بۆیە لە ماڵەوە تاقی مەکەرەوە. چاککردنەوە تۆمار بکە تا تەکنیکار بیپشکنێت.",
      ),
      { type: "repair" },
      t3(
        "إن كانت اليد ضمن الضمان فلا تفتحها؛ فتحها يُبطله.",
        "If the controller is under warranty, do not open it; opening it voids the warranty.",
        "ئەگەر دەسکەکە لە ژێر گەرەنتیدایە، مەیکەرەوە؛ کردنەوەی گەرەنتی بەتاڵ دەکاتەوە.",
      ),
    ),
  ],
};

// ───────────────────────────────────────────────────────────────── no power

const TURNED_ON = t3("اشتغل", "It turned on", "داگیرسا");
const STILL_OFF = t3("لم يشتغل", "It did not turn on", "دانەگیرسا");

const articleOutcome = (id: string, device: string, articleSlug: string): TroubleshootingNode =>
  outcome(
    id,
    t3(
      `اتبع قسم «الجهاز لا يشتغل» في مقال ${device}. إن لم ينجح فاحجز صيانة.`,
      `Follow the “will not turn on” section of the ${device} article. If that does not work, book a repair.`,
      `بەشی «ئامێرەکە داناگیرسێت» لە بابەتی ${device} جێبەجێ بکە. ئەگەر سەرکەوتوو نەبوو، چاککردنەوە تۆمار بکە.`,
    ),
    { type: "article", articleSlug },
  );

const NO_POWER: TroubleshootingTree = {
  start: "danger_check",
  nodes: [
    question(
      "danger_check",
      t3(
        "قبل أي شيء: هل لاحظت رائحة احتراق، دخاناً، انتفاخاً في الجهاز، حرارة شديدة، أو دخول سائل إليه؟",
        "Before anything else: have you noticed a burning smell, smoke, swelling, intense heat, or liquid getting into the device?",
        "پێش هەموو شتێک: ئایا بۆنی سووتان، دووکەڵ، ئاوسانی ئامێرەکە، گەرمیی زۆر، یان چوونە ژوورەوەی شلەت بینیوە؟",
      ),
      [option(t3("نعم", "Yes", "بەڵێ"), "danger"), option(t3("لا", "No", "نەخێر"), "symptom")],
    ),
    outcome(
      "danger",
      t3(
        "توقف الآن: افصل الجهاز عن الكهرباء ولا تشحنه ولا تحاول تشغيله أو فتحه. احجز صيانة وأخبرنا بما لاحظت.",
        "Stop now: unplug the device, do not charge it, and do not try to switch it on or open it. Book a repair and tell us what you noticed.",
        "ئێستا بوەستە: ئامێرەکە لە کارەبا بپچڕێنە، بارگاوی مەکە، و هەوڵی داگیرساندن یان کردنەوەی مەدە. چاککردنەوە تۆمار بکە و پێمان بڵێ چیت بینیوە.",
      ),
      { type: "repair" },
      t3(
        "بطاريات الليثيوم ومزوّدات الطاقة قد تسبب حريقاً أو صعقة كهربائية. لا تحاول إصلاحها بنفسك.",
        "Lithium batteries and power supplies can cause fire or electric shock. Do not try to repair them yourself.",
        "پاتریی لیتیۆم و دابینکەری کارەبا دەتوانن ببنە هۆی ئاگر یان کارەبالێدان. هەوڵ مەدە خۆت چاکیان بکەیتەوە.",
      ),
    ),
    question("symptom", t3("ماذا يحدث عند الضغط على زر التشغيل؟", "What happens when you press the power button?", "کاتێک دوگمەی داگیرساندن دادەگریت چی ڕوودەدات؟"), [
      option(t3("لا شيء إطلاقاً", "Nothing at all", "هیچ شتێک"), "power_source"),
      option(t3("ضوء أو صوت، لكن بلا صورة", "A light or a sound, but no picture", "ڕووناکی یان دەنگ هەیە، بەڵام وێنە نییە"), "display"),
      option(t3("يشتغل ثم ينطفئ", "It turns on, then shuts off", "دادەگیرسێت و پاشان دەکوژێتەوە"), "shuts_off"),
    ]),
    stepNode(
      "power_source",
      t3(
        "تحقق من مصدر الكهرباء: صِل الجهاز بمقبس جداري مباشرة من دون موزّع، وتأكد أن الكيبل مثبّت من الطرفين. الأجهزة المحمولة: اشحنها 30 دقيقة بالشاحن الأصلي.",
        "Check the power source: plug the device straight into a wall outlet without a power strip, and make sure the cable is firmly seated at both ends. Handhelds: charge for 30 minutes with the original charger.",
        "سەرچاوەی کارەبا بپشکنە: ئامێرەکە ڕاستەوخۆ بە پریزی دیوار ببەستە بێ دابەشکەر، و دڵنیا بە کێبڵەکە لە هەردوو سەرەوە توند بەستراوە. ئامێرە دەستییەکان: 30 خولەک بە بارگاویکەری ئەسڵی بارگاوییان بکە.",
      ),
      [option(TURNED_ON, "resolved"), option(STILL_OFF, "power_cycle")],
      t3("لا تستخدم كيبلاً مقطوعاً أو متضرراً.", "Do not use a cut or damaged cable.", "کێبڵی بڕاو یان زیانلێکەوتوو بەکارمەهێنە."),
    ),
    stepNode(
      "power_cycle",
      t3(
        "افصل الكهرباء دقيقة كاملة ثم أعد توصيلها. في الأجهزة المحمولة اضغط زر التشغيل مطولاً من 10 إلى 15 ثانية، ثم اضغطه مرة واحدة.",
        "Unplug the power for a full minute, then plug it back in. On handhelds, hold the power button for 10 to 15 seconds, then press it once.",
        "کارەبا بۆ خولەکێکی تەواو بپچڕێنە و پاشان دووبارە بیبەستەوە. لە ئامێرە دەستییەکاندا دوگمەی داگیرساندن 10 تا 15 چرکە داگرە، پاشان یەک جار دایبگرە.",
      ),
      [option(TURNED_ON, "resolved"), option(STILL_OFF, "device")],
    ),
    stepNode(
      "display",
      t3(
        "قد تكون المشكلة في الصورة لا في التشغيل: افصل كيبل HDMI من الطرفين وأعد توصيله، جرّب مدخلاً آخر في التلفاز، وتأكد أن التلفاز على المدخل الصحيح. في الأجهزة المحمولة ارفع سطوع الشاشة.",
        "The problem may be the picture, not the power: unplug the HDMI cable at both ends and plug it back in, try another input on the TV, and check that the TV is set to the right input. On handhelds, turn the screen brightness up.",
        "لەوانەیە کێشەکە لە وێنەدا بێت نەک لە داگیرساندن: کێبڵی HDMI لە هەردوو سەرەوە بپچڕێنە و دووبارە بیبەستەوە، دەرچەیەکی تر لە تەلەفزیۆنەکە تاقی بکەرەوە، و دڵنیا بە تەلەفزیۆنەکە لەسەر دەرچەی دروستە. لە ئامێرە دەستییەکاندا ڕووناکیی شاشە بەرز بکەرەوە.",
      ),
      [option(t3("ظهرت الصورة", "The picture is back", "وێنە گەڕایەوە"), "resolved"), option(t3("لم تظهر", "Still no picture", "هێشتا وێنە نییە"), "device")],
    ),
    stepNode(
      "shuts_off",
      t3(
        "الانطفاء بعد التشغيل سببه الشائع الحرارة أو مصدر الكهرباء: أبعد الجهاز عن الجدار، اكشف فتحات التهوية، اتركه يبرد ساعة، ثم جرّبه على مقبس جداري مباشر.",
        "Shutting off after starting is commonly caused by heat or the power source: move the device away from the wall, uncover the vents, let it cool for an hour, then try it on a wall outlet directly.",
        "کوژانەوە دوای داگیرساندن زۆربەی کات بەهۆی گەرمی یان سەرچاوەی کارەباوەیە: ئامێرەکە لە دیوار دوور بخەرەوە، کونەکانی هەواگۆڕکێ بکەرەوە، کاتژمێرێک بیهێڵە سارد ببێتەوە، پاشان ڕاستەوخۆ لەسەر پریزی دیوار تاقی بکەرەوە.",
      ),
      [option(t3("استقر", "It stays on now", "ئێستا جێگیرە"), "resolved"), option(t3("ما زال ينطفئ", "It still shuts off", "هێشتا دەکوژێتەوە"), "repair")],
    ),
    question(
      "device",
      t3(
        "ما جهازك؟ لكل جهاز خطوات آمنة إضافية.",
        "Which device do you have? Each one has a few more safe steps.",
        "ئامێرەکەت چییە؟ هەر ئامێرێک چەند هەنگاوێکی سەلامەتی زیاتری هەیە.",
      ),
      [
        option(same("Nintendo Switch 2"), "article_switch_2"),
        option(same("PlayStation 5"), "article_ps5"),
        option(same("Xbox Series X"), "article_xbox"),
        option(t3("حاسوب ألعاب محمول", "Handheld gaming PC", "کۆمپیوتەری یاریی دەستی"), "article_handheld"),
        option(t3("جهاز آخر", "Another device", "ئامێرێکی تر"), "repair"),
      ],
    ),
    articleOutcome("article_switch_2", "Nintendo Switch 2", "switch-2-safe-troubleshooting"),
    articleOutcome("article_ps5", "PlayStation 5", "ps5-safe-troubleshooting"),
    articleOutcome("article_xbox", "Xbox Series X", "xbox-series-x-safe-troubleshooting"),
    outcome(
      "article_handheld",
      t3(
        "اتبع قسم «الجهاز لا يشتغل» في مقال حواسيب الألعاب المحمولة. إن لم ينجح فاحجز صيانة.",
        "Follow the “will not turn on” section of the handheld gaming PC article. If that does not work, book a repair.",
        "بەشی «ئامێرەکە داناگیرسێت» لە بابەتی کۆمپیوتەری یاریی دەستی جێبەجێ بکە. ئەگەر سەرکەوتوو نەبوو، چاککردنەوە تۆمار بکە.",
      ),
      { type: "article", articleSlug: "handheld-pc-safe-troubleshooting" },
    ),
    outcome(
      "resolved",
      t3(
        "جيد. إن تكرر الأمر فدوّن متى يحدث (بعد لعب طويل؟ أثناء الشحن؟) واحجز فحصاً.",
        "Good. If it happens again, note when (after a long session? while charging?) and book an inspection.",
        "باشە. ئەگەر دووبارە بووەوە، تێبینی بکە کەی ڕوودەدات (دوای یاریی درێژ؟ لە کاتی بارگاویکردندا؟) و پشکنین تۆمار بکە.",
      ),
      { type: "resolved" },
    ),
    outcome(
      "repair",
      t3(
        "لم تنجح الخطوات الآمنة، والسبب لا يمكن تحديده من الوصف وحده. احجز صيانة ليفحص الفني مصدر الطاقة والجهاز.",
        "The safe steps did not work, and the cause cannot be determined from a description alone. Book a repair so a technician can check the power supply and the device.",
        "هەنگاوە سەلامەتەکان سەرکەوتوو نەبوون، و هۆکارەکە تەنها لە وەسفەوە دیاری ناکرێت. چاککردنەوە تۆمار بکە تا تەکنیکار دابینکەری کارەبا و ئامێرەکە بپشکنێت.",
      ),
      { type: "repair" },
    ),
  ],
};

export const DEMO_TREES: readonly TreeSeed[] = [
  { symptomKey: "stick_drift", title: STICK_DRIFT_TREE_TITLE, tree: STICK_DRIFT },
  { symptomKey: "no_power", title: t3("الجهاز لا يشتغل", "Console does not power on", "ئامێرەکە داناگیرسێت"), tree: NO_POWER },
];
