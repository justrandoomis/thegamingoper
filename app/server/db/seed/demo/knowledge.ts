/**
 * DEMO knowledge articles: a first-time setup guide and a "safe fixes" article for Switch 2,
 * PlayStation 5, Xbox Series X and handheld gaming PCs. They hang on the device models of
 * ./devices.ts (switch-2, ps5-slim, xbox-series-x; the handheld articles on the whole platform), and
 * their pictures are the devices' official photos. Statements were checked against the researched
 * catalogue (catalog/products): microSD Express on Switch 2, the USB cable in the PS5 Slim box but
 * not the PS5 Pro box, AA batteries for the Xbox controller (whether they come in the box is not
 * published), SteamOS and Windows handhelds, the makers' apps.
 *
 * Rules these articles follow (brief §7):
 *   · only steps a shopper can do without opening the device, taken from the makers' own guidance
 *   · no battery or electrical do-it-yourself work — each article says where to stop
 *   · every troubleshooting article ends with "book a repair", never with a guessed diagnosis
 *
 * They are stored as approved so the help centre and the maintenance assistant have content, and
 * flagged is_demo: a technician of the store has not reviewed them yet (`approved_by` is empty).
 */
import type { ArticleKind } from "../../schema";
import { art, callout, h2, p, step, steps, ul, type TBlock } from "./blocks";
import type { PlatformSlug } from "./devices";
import { same, t3, type T3 } from "./text";

export type ArticleSeed = {
  slug: string;
  kind: ArticleKind;
  title: T3;
  summary: T3;
  /** Device the article is about; empty = applies to the whole platform. */
  deviceModel?: string;
  platform: PlatformSlug;
  tags: string[];
  blocks: TBlock[];
};

// ───────────────────────────────────────────────────────────────── shared pieces

const H_STEPS = h2(t3("الخطوات", "Steps", "هەنگاوەکان"));
const H_PLACE = h2(t3("اختر المكان", "Choose the spot", "شوێنەکە هەڵبژێرە"));
const H_NO_POWER = h2(t3("الجهاز لا يشتغل", "The device will not turn on", "ئامێرەکە داناگیرسێت"));
const SAFETY = t3("للسلامة", "For safety", "بۆ سەلامەتی");
const STOP_NOW = t3("توقف فوراً في هذه الحالات", "Stop at once in these cases", "لەم حاڵەتانەدا دەستبەجێ بوەستە");
const MOVE_DATA = t3("انقل بياناتك (اختياري)", "Move your data (optional)", "داتاکانت بگوازەوە (ئارەزوومەندانە)");
const ADD_STORAGE = t3("وسّع التخزين", "Add storage", "بیرگە زیاد بکە");

const SAFE_SCOPE = callout(
  "info",
  t3(
    "هذه خطوات آمنة لا تتطلب فتح الجهاز. إن لم تحلّ المشكلة فالخطوة التالية فحص لدى فني، لا محاولة إصلاح في البيت.",
    "These are safe steps that do not involve opening the device. If they do not solve the problem, the next step is a check by a technician, not a home repair.",
    "ئەمانە هەنگاوی سەلامەتن و پێویستیان بە کردنەوەی ئامێرەکە نییە. ئەگەر کێشەکەیان چارەسەر نەکرد، هەنگاوی داهاتوو پشکنینە لەلایەن تەکنیکارەوە، نەک هەوڵی چاککردنەوە لە ماڵەوە.",
  ),
);

const BOOK_REPAIR = p(
  t3(
    "لم تُحلّ المشكلة؟ احجز صيانة من صفحة الدعم واذكر ما جرّبته من هذه الخطوات؛ ذلك يختصر وقت الفحص.",
    "Still not solved? Book a repair from the support page and tell us which of these steps you tried; it shortens the inspection.",
    "کێشەکە چارەسەر نەبوو؟ لە پەڕەی پشتگیرییەوە چاککردنەوە تۆمار بکە و بڵێ کام لەم هەنگاوانەت تاقی کردووەتەوە؛ ئەمە کاتی پشکنین کورت دەکاتەوە.",
  ),
);

const BATTERY_DANGER = callout(
  "danger",
  t3(
    "انتفاخ في ظهر الجهاز أو ارتفاع الشاشة عن إطارها، حرارة شديدة، رائحة احتراق، أو دخول سائل. لا تشحن الجهاز ولا تفتحه ولا تحاول استبدال البطارية بنفسك: بطاريات الليثيوم قد تشتعل. احجز صيانة.",
    "A swollen back or a screen lifting from its frame, intense heat, a burning smell, or liquid inside. Do not charge the device, open it or try to replace the battery yourself: lithium batteries can catch fire. Book a repair.",
    "ئاوسانی پشتی ئامێرەکە یان بەرزبوونەوەی شاشە لە چوارچێوەکەی، گەرمیی زۆر، بۆنی سووتان، یان چوونە ژوورەوەی شلە. ئامێرەکە بارگاوی مەکە، مەیکەرەوە و هەوڵ مەدە خۆت پاترییەکە بگۆڕیت: پاتریی لیتیۆم دەتوانێت ئاگر بگرێت. چاککردنەوە تۆمار بکە.",
  ),
  STOP_NOW,
);

const POWER_SUPPLY_DANGER = callout(
  "danger",
  t3(
    "رائحة احتراق، شرر، دخان، أو انطفاء متكرر مع صوت طقطقة: افصل الكهرباء ولا تعد التشغيل. لا تفتح الجهاز ولا مزوّد الطاقة إطلاقاً؛ قد يحتفظ بشحنة خطرة حتى بعد فصله. احجز صيانة.",
    "A burning smell, sparks, smoke, or repeated shutdowns with a clicking sound: unplug the console and do not switch it on again. Never open the console or its power supply; it can hold a dangerous charge even when unplugged. Book a repair.",
    "بۆنی سووتان، پریشک، دووکەڵ، یان کوژانەوەی دووبارە لەگەڵ دەنگی تەقەتەق: کارەباکە بپچڕێنە و دووبارە دایمەگیرسێنە. هەرگیز ئامێرەکە یان دابینکەری کارەباکەی مەکەرەوە؛ دەتوانێت تەنانەت دوای پچڕاندنیش بارگەیەکی مەترسیدار هەڵبگرێت. چاککردنەوە تۆمار بکە.",
  ),
  STOP_NOW,
);

const STICK_DRIFT_TREE = t3("انحراف عصا التحكم", "Controller stick drift", "لادانی جۆیستیکی دەسکی یاری");

/** The device's main official photo (the first image of the catalogue product that is the device). */
const devicePhoto = (photoKey: string, name: string): TBlock => art(photoKey, same(name));

// ───────────────────────────────────────────────────────────────── articles

export const DEMO_ARTICLES: readonly ArticleSeed[] = [
  {
    slug: "switch-2-first-setup",
    kind: "setup",
    title: t3("تجهيز Nintendo Switch 2 لأول مرة", "Setting up your Nintendo Switch 2 for the first time", "ئامادەکردنی Nintendo Switch 2 بۆ یەکەم جار"),
    summary: t3(
      "من فتح العلبة إلى أول لعبة: الشحن، تركيب Joy-Con 2، التوصيل بالتلفاز ونقل بياناتك من Switch سابق.",
      "From the box to your first game: charging, attaching the Joy-Con 2, connecting to the TV and moving your data from an earlier Switch.",
      "لە کردنەوەی قوتووەکەوە تا یەکەم یاری: بارگاویکردن، لکاندنی Joy-Con 2، بەستن بە تەلەفزیۆن و گواستنەوەی داتاکانت لە Switchـی پێشوو.",
    ),
    deviceModel: "switch-2",
    platform: "nintendo",
    tags: ["setup", "switch-2"],
    blocks: [
      devicePhoto("nintendo-switch-2--1", "Nintendo Switch 2"),
      h2(t3("ما تحتاجه", "What you need", "ئەوەی پێویستتە")),
      ul(
        t3(
          "الجهاز ويدا Joy-Con 2 ومحوّل الطاقة وكيبل USB-C المرفقة",
          "The console, the Joy-Con 2 controllers, the AC adapter and the USB-C cable from the box",
          "ئامێرەکە، دەسکەکانی Joy-Con 2، ئەداپتەری کارەبا و کێبڵی USB-C کە لە قوتووەکەدان",
        ),
        t3(
          "شبكة Wi-Fi وحساب Nintendo (يمكن إنشاؤه أثناء الإعداد)",
          "A Wi-Fi network and a Nintendo Account (you can create one during setup)",
          "تۆڕی Wi-Fi و هەژماری Nintendo (دەتوانیت لە کاتی ئامادەکردندا دروستی بکەیت)",
        ),
        t3(
          "للّعب على التلفاز: القاعدة وكيبل HDMI المرفقان",
          "For TV play: the dock and the HDMI cable from the box",
          "بۆ یاری لەسەر تەلەفزیۆن: بنکە و کێبڵی HDMI کە لە قوتووەکەدان",
        ),
      ),
      H_STEPS,
      steps(
        step(
          t3("اشحن الجهاز", "Charge the console", "ئامێرەکە بارگاوی بکە"),
          t3(
            "صِل محوّل الطاقة الأصلي بمنفذ USB-C أسفل الجهاز. يمكنك متابعة الإعداد أثناء الشحن.",
            "Plug the original AC adapter into the USB-C port on the bottom of the console. You can carry on with setup while it charges.",
            "ئەداپتەری کارەبای ئەسڵی بە دەرچەی USB-Cـی خوارەوەی ئامێرەکە ببەستە. دەتوانیت لە کاتی بارگاویکردندا ئامادەکردن بەردەوام بکەیت.",
          ),
        ),
        step(
          t3("ركّب يدَي Joy-Con 2", "Attach the Joy-Con 2", "دەسکەکانی Joy-Con 2 بلکێنە"),
          t3(
            "قرّب كل يد من جانب الجهاز حتى تثبت مغناطيسياً. لفصلها اضغط زر التحرير خلف اليد ثم اسحبها.",
            "Bring each controller to the side of the console until it snaps on magnetically. To detach it, press the release button on the back of the controller and pull it away.",
            "هەر دەسکێک لە لای ئامێرەکە نزیک بکەرەوە تا بە موگناتیس جێگیر دەبێت. بۆ جیاکردنەوەی، دوگمەی ئازادکردن لە پشتی دەسکەکە داگرە و ڕایبکێشە.",
          ),
        ),
        step(
          t3("شغّل الجهاز واتبع التعليمات", "Switch on and follow the prompts", "ئامێرەکە داگیرسێنە و ڕێنماییەکان جێبەجێ بکە"),
          t3(
            "اضغط زر التشغيل أعلى الجهاز، ثم اختر اللغة والمنطقة واتصل بشبكة Wi-Fi.",
            "Press the power button on top of the console, then choose your language and region and connect to Wi-Fi.",
            "دوگمەی داگیرساندن لە سەرەوەی ئامێرەکە داگرە، پاشان زمان و ناوچە هەڵبژێرە و بە Wi-Fi ببەسترە.",
          ),
        ),
        step(
          MOVE_DATA,
          t3(
            "إن كان لديك Switch سابق، يعرض الجهاز «نقل بيانات النظام» أثناء الإعداد الأول فقط. ضع الجهازين قرب بعضهما وأبقِهما على الشاحن حتى ينتهي النقل.",
            "If you have an earlier Switch, the console offers a system transfer during first-time setup only. Keep both consoles close together and on their chargers until the transfer finishes.",
            "ئەگەر Switchـێکی پێشووت هەیە، ئامێرەکە «گواستنەوەی داتای سیستەم» تەنها لە کاتی یەکەم ئامادەکردندا پێشکەش دەکات. هەردوو ئامێرەکە لە نزیک یەکتر دابنێ و تا تەواوبوونی گواستنەوە لەسەر بارگاویکەر بیانهێڵەوە.",
          ),
        ),
        step(
          t3("وصّله بالتلفاز", "Connect it to the TV", "بە تەلەفزیۆنەوە بیبەستە"),
          t3(
            "صِل القاعدة بالكهرباء وبالتلفاز عبر كيبل HDMI، ثم ضع الجهاز في القاعدة والشاشة نحو الأمام.",
            "Connect the dock to power and to the TV with the HDMI cable, then place the console in the dock with the screen facing forward.",
            "بنکەکە بە کارەبا و لە ڕێگەی کێبڵی HDMIـەوە بە تەلەفزیۆن ببەستە، پاشان ئامێرەکە بخە ناو بنکەکە و شاشەکەی ڕووی لە پێشەوە بێت.",
          ),
        ),
        step(
          ADD_STORAGE,
          t3(
            "لا تُحفظ الألعاب إلا على بطاقات microSD Express (حتى 2TB)؛ بطاقة microSD العادية من Switch سابق يفتح منها الجهاز لقطات الشاشة والفيديوهات فقط. أطفئ الجهاز تماماً قبل إدخال البطاقة في فتحتها أو إخراجها.",
            "Games can be stored only on microSD Express cards (up to 2TB); from an ordinary microSD card of an earlier Switch the console only opens screenshots and videos. Switch the console off completely before inserting the card into its slot or removing it.",
            "یاری تەنها لەسەر کارتی microSD Express (تا 2TB) هەڵدەگیرێت؛ لە کارتی microSDی ئاسایی Switchـی پێشوو ئامێرەکە تەنها وێنەی شاشە و ڤیدیۆ دەکاتەوە. پێش خستنە ناوەوەی کارتەکە بۆ شوێنەکەی یان دەرهێنانی، ئامێرەکە بە تەواوی بکوژێنەوە.",
          ),
        ),
      ),
      callout(
        "warning",
        t3(
          "استخدم محوّل الطاقة الأصلي أو محوّلاً معتمداً. إذا لاحظت انتفاخاً أو حرارة غير طبيعية أو رائحة احتراق فأوقف الشحن فوراً ولا تفتح الجهاز، واحجز فحصاً.",
          "Use the original AC adapter or an approved one. If you notice swelling, unusual heat or a burning smell, stop charging at once, do not open the console, and book an inspection.",
          "ئەداپتەری کارەبای ئەسڵی یان ئەداپتەرێکی پەسەندکراو بەکاربهێنە. ئەگەر ئاوسان، گەرمیی نائاسایی یان بۆنی سووتانت بینی، دەستبەجێ بارگاویکردن بوەستێنە، ئامێرەکە مەکەرەوە و پشکنین تۆمار بکە.",
        ),
        SAFETY,
      ),
    ],
  },
  {
    slug: "switch-2-safe-troubleshooting",
    kind: "troubleshooting",
    title: t3(
      "Nintendo Switch 2: حلول آمنة للمشكلات الشائعة",
      "Nintendo Switch 2: safe fixes for common problems",
      "Nintendo Switch 2: چارەسەری سەلامەت بۆ کێشە باوەکان",
    ),
    summary: t3(
      "الجهاز لا يشتغل، لا صورة على التلفاز، أو العصا تتحرك وحدها: ما يمكنك تجربته بأمان قبل حجز صيانة.",
      "The console will not turn on, there is no picture on the TV, or a stick moves by itself: what you can safely try before booking a repair.",
      "ئامێرەکە داناگیرسێت، وێنە لەسەر تەلەفزیۆن نییە، یان جۆیستیک خۆی دەجووڵێت: ئەوەی دەتوانیت بە سەلامەتی تاقی بکەیتەوە پێش تۆمارکردنی چاککردنەوە.",
    ),
    deviceModel: "switch-2",
    platform: "nintendo",
    tags: ["troubleshooting", "power", "display", "stick-drift", "switch-2"],
    blocks: [
      SAFE_SCOPE,
      h2(t3("الجهاز لا يشتغل أو الشاشة سوداء", "The console will not turn on, or the screen stays black", "ئامێرەکە داناگیرسێت یان شاشەکە ڕەشە")),
      steps(
        step(
          t3("اشحنه 30 دقيقة", "Charge it for 30 minutes", "30 خولەک بارگاوی بکە"),
          t3(
            "استخدم محوّل الطاقة الأصلي موصولاً بالجهاز مباشرة، لا عبر القاعدة.",
            "Use the original AC adapter plugged straight into the console, not through the dock.",
            "ئەداپتەری کارەبای ئەسڵی بەکاربهێنە کە ڕاستەوخۆ بە ئامێرەکەوە بەستراوە، نەک لە ڕێگەی بنکەوە.",
          ),
        ),
        step(
          t3("أعد تشغيله بالقوة", "Force a restart", "بە زۆر دایبگیرسێنەوە"),
          t3(
            "اضغط زر التشغيل مطولاً نحو 12 ثانية ثم اتركه، واضغطه مرة واحدة لتشغيل الجهاز.",
            "Hold the power button for about 12 seconds, release it, then press it once to switch the console on.",
            "دوگمەی داگیرساندن نزیکەی 12 چرکە داگرە و بەریبدە، پاشان یەک جار دایبگرە بۆ داگیرساندنی ئامێرەکە.",
          ),
        ),
        step(
          t3("غيّر مصدر الكهرباء", "Try another outlet", "سەرچاوەی کارەبا بگۆڕە"),
          t3(
            "جرّب مقبساً آخر وتأكد أن الكيبل غير متضرر.",
            "Try a different wall outlet and check that the cable is not damaged.",
            "پریزێکی تر تاقی بکەرەوە و دڵنیا بە کێبڵەکە زیانی پێنەگەیشتووە.",
          ),
        ),
      ),
      h2(t3("لا تظهر الصورة على التلفاز", "No picture on the TV", "وێنە لەسەر تەلەفزیۆن دەرناکەوێت")),
      ul(
        t3(
          "تأكد أن القاعدة موصولة بمحوّل الطاقة الأصلي.",
          "Check that the dock is connected to the original AC adapter.",
          "دڵنیا بە بنکەکە بە ئەداپتەری کارەبای ئەسڵییەوە بەستراوە.",
        ),
        t3(
          "افصل كيبل HDMI من الطرفين وأعد توصيله، وجرّب مدخل HDMI آخر في التلفاز.",
          "Unplug the HDMI cable at both ends and plug it back in, and try another HDMI input on the TV.",
          "کێبڵی HDMI لە هەردوو سەرەوە بپچڕێنە و دووبارە بیبەستەوە، و دەرچەیەکی تری HDMI لە تەلەفزیۆنەکە تاقی بکەرەوە.",
        ),
        t3(
          "أخرج الجهاز من القاعدة ثم أعده بعد عشر ثوانٍ.",
          "Take the console out of the dock and put it back after ten seconds.",
          "ئامێرەکە لە بنکەکە دەربهێنە و دوای دە چرکە بیخەرەوە ناوی.",
        ),
      ),
      h2(t3("عصا التحكم تتحرك وحدها", "A stick moves by itself", "جۆیستیک خۆی دەجووڵێت")),
      p(
        t3(
          `من إعدادات النظام افتح قسم أيدي التحكم واختر معايرة عصا التحكم، وحدّث برنامج اليد. إن استمرت المشكلة فاستخدم التشخيص الموجَّه «${STICK_DRIFT_TREE.ar}».`,
          `In System Settings, open the controllers section and choose to calibrate the control sticks, and update the controller. If the problem stays, use the guided diagnosis “${STICK_DRIFT_TREE.en}”.`,
          `لە ڕێکخستنەکانی سیستەم بەشی دەسکەکان بکەرەوە و پێوانەکردنەوەی جۆیستیک هەڵبژێرە، و نەرمەکاڵای دەسکەکە نوێ بکەرەوە. ئەگەر کێشەکە بەردەوام بوو، دەستنیشانکردنی ڕێنماییکراوی «${STICK_DRIFT_TREE.ckb}» بەکاربهێنە.`,
        ),
      ),
      BATTERY_DANGER,
      BOOK_REPAIR,
    ],
  },
  {
    slug: "ps5-first-setup",
    kind: "setup",
    title: t3("تجهيز PlayStation 5 لأول مرة", "Setting up your PlayStation 5 for the first time", "ئامادەکردنی PlayStation 5 بۆ یەکەم جار"),
    summary: t3(
      "اختيار المكان، توصيل الكيبلات، اقتران يد DualSense وتوسيع التخزين بأمان.",
      "Choosing a spot, connecting the cables, pairing the DualSense and expanding storage safely.",
      "هەڵبژاردنی شوێن، بەستنی کێبڵەکان، جووتکردنی دەسکی DualSense و فراوانکردنی بیرگە بە سەلامەتی.",
    ),
    deviceModel: "ps5-slim",
    platform: "playstation",
    tags: ["setup", "ps5"],
    blocks: [
      devicePhoto("playstation-5-slim--1", "PlayStation 5 Slim"),
      H_PLACE,
      ul(
        t3(
          "ضعه على سطح ثابت ومستوٍ، واترك 10 سم على الأقل بينه وبين الجدار.",
          "Place it on a stable, level surface and leave at least 10 cm between it and the wall.",
          "لەسەر ڕوویەکی جێگیر و تەخت دایبنێ، و لانیکەم 10 سم لە نێوان ئەو و دیوارەکە بهێڵەوە.",
        ),
        t3(
          "لا تضعه في خزانة مغلقة، ولا على سجاد أو قماش يسدّ فتحات التهوية.",
          "Do not put it in a closed cabinet, or on carpet or fabric that blocks the vents.",
          "لە کەوانتەری داخراودا دایمەنێ، و نە لەسەر فەرش یان قوماش کە کونەکانی هەواگۆڕکێ دەگرێت.",
        ),
        t3(
          "النموذج النحيف يأتي بقدمين للوضع الأفقي؛ الحامل العمودي يُباع منفصلاً.",
          "The slim model comes with two feet for horizontal placement; the vertical stand is sold separately.",
          "مۆدێلی باریک لەگەڵ دوو پێ بۆ دۆخی ئاسۆیی دێت؛ ڕاگری ستوونی بە جیا دەفرۆشرێت.",
        ),
      ),
      H_STEPS,
      steps(
        step(
          t3("وصّل الكيبلات", "Connect the cables", "کێبڵەکان ببەستە"),
          t3(
            "صِل كيبل HDMI المرفق بالتلفاز، ثم كيبل الطاقة بالجهاز وبمقبس جداري.",
            "Connect the included HDMI cable to the TV, then the power cord to the console and to a wall outlet.",
            "کێبڵی HDMIـی هاوپێچ بە تەلەفزیۆن ببەستە، پاشان کێبڵی کارەبا بە ئامێرەکە و بە پریزی دیوار.",
          ),
        ),
        step(
          t3("اقرن يد DualSense", "Pair the DualSense", "دەسکی DualSense جووت بکە"),
          t3(
            "صِل اليد بالجهاز بكيبل USB، ثم اضغط زر PS. علبة PS5 Slim فيها كيبل USB، أما علبة PS5 Pro فليس فيها.",
            "Connect the controller to the console with a USB cable, then press the PS button. The PS5 Slim box includes one; the PS5 Pro box does not.",
            "دەسکەکە بە کێبڵی USB بە ئامێرەکە ببەستە، پاشان دوگمەی PS داگرە. قوتووی PS5 Slim کێبڵی USBـی تێدایە، بەڵام قوتووی PS5 Pro نییەتی.",
          ),
        ),
        step(
          t3("اتبع الإعداد على الشاشة", "Follow the on-screen setup", "ئامادەکردنی سەر شاشە جێبەجێ بکە"),
          t3(
            "اختر اللغة، اتصل بالإنترنت، وسجّل الدخول إلى حسابك في PlayStation Network أو أنشئ حساباً.",
            "Choose your language, connect to the internet, and sign in to PlayStation Network or create an account.",
            "زمان هەڵبژێرە، بە ئینتەرنێت ببەسترە، و بچۆ ژوورەوەی هەژمارەکەت لە PlayStation Network یان هەژمارێک دروست بکە.",
          ),
        ),
        step(
          t3("حدّث النظام", "Update the system", "سیستەم نوێ بکەرەوە"),
          t3(
            "ثبّت تحديث برنامج النظام إن عُرض عليك قبل بدء اللعب.",
            "Install the system software update if one is offered before you start playing.",
            "ئەگەر نوێکردنەوەی نەرمەکاڵای سیستەمت پێشکەش کرا، پێش دەستپێکردنی یاری دایبمەزرێنە.",
          ),
        ),
        step(
          MOVE_DATA,
          t3(
            "يمكنك نقل الألعاب والبيانات المحفوظة من PS4 أو من PS5 آخر عبر الشبكة، أثناء الإعداد أو لاحقاً من الإعدادات.",
            "You can transfer games and saved data from a PS4 or another PS5 over the network, during setup or later from Settings.",
            "دەتوانیت یاری و داتای پاشەکەوتکراو لە PS4 یان PS5ـێکی ترەوە لە ڕێگەی تۆڕەوە بگوازیتەوە، لە کاتی ئامادەکردندا یان دواتر لە ڕێکخستنەکانەوە.",
          ),
        ),
      ),
      h2(t3("توسيع التخزين", "Expanding storage", "فراوانکردنی بیرگە")),
      p(
        t3(
          "يمكن إضافة قرص M.2 NVMe SSD مطابق لمتطلبات Sony في الفتحة الداخلية. التركيب إجراء موثّق من Sony ويحتاج مفكاً فقط، بعد إطفاء الجهاز وفصل كيبل الطاقة. إن لم تكن مرتاحاً لذلك فنحن نركّبه لك في المتجر.",
          "You can add an M.2 NVMe SSD that meets Sony's requirements to the internal slot. Fitting it is a procedure documented by Sony and needs only a screwdriver, after switching the console off and unplugging the power cord. If you are not comfortable doing it, we fit it for you in the store.",
          "دەتوانیت M.2 NVMe SSDـێک کە لەگەڵ مەرجەکانی Sony دەگونجێت لە شوێنە ناوەکییەکەدا زیاد بکەیت. دانانی ڕێکارێکە کە Sony بەڵگەنامەی کردووە و تەنها پێویستی بە پێچکەرەوەیەک هەیە، دوای کوژاندنەوەی ئامێرەکە و پچڕاندنی کێبڵی کارەبا. ئەگەر لێی دڵنیا نیت، ئێمە لە فرۆشگا بۆت دادەنێین.",
        ),
      ),
      callout(
        "warning",
        t3(
          "لا تفتح مزوّد الطاقة ولا أي جزء غير غطاء فتحة التوسعة. أي عمل كهربائي داخل الجهاز يُترك للفني.",
          "Do not open the power supply or any part other than the expansion slot cover. Any electrical work inside the console is for a technician.",
          "دابینکەری کارەبا و هیچ بەشێکی تر جگە لە سەرپۆشی شوێنی فراوانکردن مەکەرەوە. هەر کارێکی کارەبایی لە ناو ئامێرەکەدا بۆ تەکنیکار جێبهێڵە.",
        ),
        SAFETY,
      ),
    ],
  },
  {
    slug: "ps5-safe-troubleshooting",
    kind: "troubleshooting",
    title: t3("PlayStation 5: حلول آمنة للمشكلات الشائعة", "PlayStation 5: safe fixes for common problems", "PlayStation 5: چارەسەری سەلامەت بۆ کێشە باوەکان"),
    summary: t3(
      "الجهاز لا يشتغل، صورة سوداء، أو مروحة مرتفعة الصوت: خطوات آمنة قبل حجز صيانة.",
      "The console will not turn on, the picture is black, or the fan is loud: safe steps before booking a repair.",
      "ئامێرەکە داناگیرسێت، وێنە ڕەشە، یان دەنگی پانکە بەرزە: هەنگاوی سەلامەت پێش تۆمارکردنی چاککردنەوە.",
    ),
    deviceModel: "ps5-slim",
    platform: "playstation",
    tags: ["troubleshooting", "power", "display", "overheating", "ps5"],
    blocks: [
      SAFE_SCOPE,
      H_NO_POWER,
      steps(
        step(
          t3("أعد توصيل الكهرباء", "Reconnect the power", "کارەبا دووبارە ببەستەوە"),
          t3(
            "افصل كيبل الطاقة من الجهاز ومن المقبس، انتظر بضع دقائق، ثم صِله بمقبس جداري مباشرة من دون موزّع كهرباء.",
            "Unplug the power cord from the console and the outlet, wait a few minutes, then plug it straight into a wall outlet without a power strip.",
            "کێبڵی کارەبا لە ئامێرەکە و لە پریزەکە بپچڕێنە، چەند خولەکێک چاوەڕێ بکە، پاشان ڕاستەوخۆ بە پریزی دیوار بیبەستە بێ دابەشکەری کارەبا.",
          ),
        ),
        step(
          t3("استخدم زر الجهاز", "Use the console's own button", "دوگمەی خودی ئامێرەکە بەکاربهێنە"),
          t3(
            "اضغط زر التشغيل في الجهاز نفسه، لا زر PS في اليد.",
            "Press the power button on the console itself, not the PS button on the controller.",
            "دوگمەی داگیرساندنی خودی ئامێرەکە داگرە، نەک دوگمەی PSـی سەر دەسکەکە.",
          ),
        ),
        step(
          t3("جرّب كيبلاً آخر", "Try another cord", "کێبڵێکی تر تاقی بکەرەوە"),
          t3(
            "إن توفر كيبل طاقة آخر من النوع نفسه فجرّبه.",
            "If you have another power cord of the same type, try it.",
            "ئەگەر کێبڵێکی تری کارەبای هەمان جۆرت هەیە، تاقی بکەرەوە.",
          ),
        ),
      ),
      h2(t3("صورة سوداء أو لا توجد إشارة", "Black picture or no signal", "وێنەی ڕەش یان سیگناڵ نییە")),
      steps(
        step(
          t3("تحقق من HDMI", "Check the HDMI", "HDMI بپشکنە"),
          t3(
            "استخدم كيبل HDMI المرفق وجرّب مدخل HDMI آخر في التلفاز.",
            "Use the included HDMI cable and try another HDMI input on the TV.",
            "کێبڵی HDMIـی هاوپێچ بەکاربهێنە و دەرچەیەکی تری HDMI لە تەلەفزیۆنەکە تاقی بکەرەوە.",
          ),
        ),
        step(
          t3("ادخل الوضع الآمن", "Start in Safe Mode", "بچۆ ناو دۆخی سەلامەت"),
          t3(
            "أطفئ الجهاز تماماً، ثم اضغط زر التشغيل مطولاً واتركه بعد سماع الصفارة الثانية.",
            "Switch the console off completely, then hold the power button and release it after the second beep.",
            "ئامێرەکە بە تەواوی بکوژێنەوە، پاشان دوگمەی داگیرساندن داگرە و دوای بیستنی دووەم بیپ بەریبدە.",
          ),
        ),
        step(
          t3("غيّر مخرج الفيديو", "Change the video output", "دەرچوونی ڤیدیۆ بگۆڕە"),
          t3(
            "صِل اليد بكيبل USB، ثم اختر من قائمة الوضع الآمن «تغيير مخرج الفيديو» وبعدها «تغيير الدقة».",
            "Connect the controller with a USB cable, then choose “Change Video Output” and “Change Resolution” in the Safe Mode menu.",
            "دەسکەکە بە کێبڵی USB ببەستە، پاشان لە لیستی دۆخی سەلامەتدا «گۆڕینی دەرچوونی ڤیدیۆ» و دواتر «گۆڕینی وردی» هەڵبژێرە.",
          ),
        ),
      ),
      h2(t3("صوت مروحة مرتفع أو رسالة ارتفاع الحرارة", "Loud fan or an overheating message", "دەنگی بەرزی پانکە یان پەیامی گەرمبوون")),
      ul(
        t3(
          "تأكد من وجود 10 سم على الأقل حول الجهاز وأبعده عن مصادر الحرارة.",
          "Make sure there are at least 10 cm of space around the console and keep it away from heat sources.",
          "دڵنیا بە لانیکەم 10 سم بۆشایی لە دەوری ئامێرەکە هەیە و لە سەرچاوەکانی گەرمی دووری بخەرەوە.",
        ),
        t3(
          "نظّف فتحات التهوية من الخارج بلطف، والجهاز مطفأ ومفصول عن الكهرباء.",
          "Gently clean the vents from the outside, with the console off and unplugged.",
          "کونەکانی هەواگۆڕکێ لە دەرەوە بە نەرمی پاک بکەرەوە، کاتێک ئامێرەکە کوژاوەتەوە و لە کارەبا پچڕاوە.",
        ),
        t3(
          "إن ظهرت رسالة ارتفاع الحرارة فأطفئ الجهاز واتركه يبرد قبل تشغيله.",
          "If the overheating message appears, switch the console off and let it cool before using it again.",
          "ئەگەر پەیامی گەرمبوون دەرکەوت، ئامێرەکە بکوژێنەوە و بیهێڵە سارد ببێتەوە پێش داگیرساندنەوەی.",
        ),
      ),
      POWER_SUPPLY_DANGER,
      BOOK_REPAIR,
    ],
  },
  {
    slug: "xbox-series-x-first-setup",
    kind: "setup",
    title: t3("تجهيز Xbox Series X لأول مرة", "Setting up your Xbox Series X for the first time", "ئامادەکردنی Xbox Series X بۆ یەکەم جار"),
    summary: t3(
      "المكان المناسب، التوصيل، الإعداد عبر تطبيق Xbox وتوسيع التخزين.",
      "The right spot, the connections, setup with the Xbox app and expanding storage.",
      "شوێنی گونجاو، بەستنەکان، ئامادەکردن لە ڕێگەی ئەپی Xbox و فراوانکردنی بیرگە.",
    ),
    deviceModel: "xbox-series-x",
    platform: "xbox",
    tags: ["setup", "xbox-series-x"],
    blocks: [
      devicePhoto("xbox-series-x--1", "XBOX Series X"),
      H_PLACE,
      ul(
        t3(
          "يعمل الجهاز عمودياً أو أفقياً. أبقِ فتحة التهوية العلوية والفتحات الخلفية مكشوفة.",
          "The console works standing or lying down. Keep the top vent and the rear vents uncovered.",
          "ئامێرەکە بە ستوونی یان ئاسۆیی کاردەکات. کونی هەواگۆڕکێی سەرەوە و کونەکانی پشتەوە بە کراوەیی بهێڵەوە.",
        ),
        t3(
          "لا تضع شيئاً فوق الجهاز، ولا تضعه في خزانة مغلقة.",
          "Do not put anything on top of the console, and do not place it in a closed cabinet.",
          "هیچ شتێک لەسەر ئامێرەکە دامەنێ، و لە کەوانتەری داخراودا دایمەنێ.",
        ),
      ),
      H_STEPS,
      steps(
        step(
          t3("وصّل الكيبلات", "Connect the cables", "کێبڵەکان ببەستە"),
          t3(
            "صِل كيبل HDMI المرفق بمنفذ HDMI OUT خلف الجهاز وبالتلفاز، ثم صِل كيبل الطاقة.",
            "Connect the included HDMI cable to the HDMI OUT port on the back of the console and to the TV, then connect the power cord.",
            "کێبڵی HDMIـی هاوپێچ بە دەرچەی HDMI OUT لە پشتی ئامێرەکە و بە تەلەفزیۆن ببەستە، پاشان کێبڵی کارەبا ببەستە.",
          ),
        ),
        step(
          t3("شغّل الجهاز واليد", "Switch on the console and the controller", "ئامێر و دەسکەکە داگیرسێنە"),
          t3(
            "اضغط زر Xbox في واجهة الجهاز. ضع بطاريتين من نوع AA في اليد (أو صِلها بكيبل USB-C)، ثم اضغط زر Xbox فيها.",
            "Press the Xbox button on the front of the console. Put two AA batteries in the controller (or connect it with a USB-C cable), then press its Xbox button.",
            "دوگمەی Xbox لە ڕووی پێشەوەی ئامێرەکە داگرە. دوو پاتریی AA بخە ناو دەسکەکە (یان بە کێبڵی USB-C بیبەستە)، پاشان دوگمەی Xboxـی سەری داگرە.",
          ),
        ),
        step(
          t3("أكمل الإعداد", "Finish setup", "ئامادەکردن تەواو بکە"),
          t3(
            "اتبع الخطوات على الشاشة، أو استخدم تطبيق Xbox على الهاتف لإدخال بيانات الشبكة والحساب أسرع.",
            "Follow the steps on screen, or use the Xbox app on your phone to enter network and account details faster.",
            "هەنگاوەکانی سەر شاشە جێبەجێ بکە، یان ئەپی Xbox لە مۆبایلەکەت بەکاربهێنە بۆ خێراتر نووسینی زانیاریی تۆڕ و هەژمار.",
          ),
        ),
        step(
          t3("حدّث النظام واليد", "Update the system and the controller", "سیستەم و دەسکەکە نوێ بکەرەوە"),
          t3(
            "ثبّت تحديث النظام إن طُلب منك، وحدّث برنامج اليد حين يُعرض عليك.",
            "Install the system update if asked, and update the controller when it is offered.",
            "ئەگەر داوات لێکرا نوێکردنەوەی سیستەم دابمەزرێنە، و کاتێک پێشکەشت کرا نەرمەکاڵای دەسکەکە نوێ بکەرەوە.",
          ),
        ),
      ),
      h2(t3("توسيع التخزين", "Expanding storage", "فراوانکردنی بیرگە")),
      p(
        t3(
          "بطاقة توسعة التخزين تُدخل في منفذ «STORAGE EXPANSION» خلف الجهاز وتشغّل ألعاب Series X|S مباشرة. أقراص USB الخارجية تصلح لتخزين الألعاب ولتشغيل ألعاب Xbox One وما قبلها.",
          "A Storage Expansion Card goes into the “STORAGE EXPANSION” port on the back of the console and runs Series X|S games directly. USB external drives are fine for storing games and for running Xbox One and earlier titles.",
          "کارتی فراوانکردنی بیرگە دەخرێتە دەرچەی «STORAGE EXPANSION» لە پشتی ئامێرەکە و یارییەکانی Series X|S ڕاستەوخۆ کارپێدەکات. دیسکی دەرەکیی USB بۆ هەڵگرتنی یاری و بۆ کارپێکردنی یارییەکانی Xbox One و پێشتر گونجاوە.",
        ),
      ),
      callout(
        "warning",
        t3(
          "استخدم كيبل الطاقة المرفق. لا تفتح الجهاز: مزوّد الطاقة في داخله، وفتحه خطر ويُبطل الضمان.",
          "Use the included power cord. Do not open the console: the power supply is inside it, and opening it is dangerous and voids the warranty.",
          "کێبڵی کارەبای هاوپێچ بەکاربهێنە. ئامێرەکە مەکەرەوە: دابینکەری کارەبا لە ناویدایە، و کردنەوەی مەترسیدارە و گەرەنتی بەتاڵ دەکاتەوە.",
        ),
        SAFETY,
      ),
    ],
  },
  {
    slug: "xbox-series-x-safe-troubleshooting",
    kind: "troubleshooting",
    title: t3("Xbox Series X: حلول آمنة للمشكلات الشائعة", "Xbox Series X: safe fixes for common problems", "Xbox Series X: چارەسەری سەلامەت بۆ کێشە باوەکان"),
    summary: t3(
      "الجهاز لا يشتغل، معلّق، بلا صورة، أو اليد لا تتصل: خطوات آمنة قبل حجز صيانة.",
      "The console will not turn on, is frozen, shows no picture, or the controller will not connect: safe steps before booking a repair.",
      "ئامێرەکە داناگیرسێت، وەستاوە، وێنەی نییە، یان دەسکەکە نابەسترێت: هەنگاوی سەلامەت پێش تۆمارکردنی چاککردنەوە.",
    ),
    deviceModel: "xbox-series-x",
    platform: "xbox",
    tags: ["troubleshooting", "power", "display", "controller", "xbox-series-x"],
    blocks: [
      SAFE_SCOPE,
      H_NO_POWER,
      steps(
        step(
          t3("أعد ضبط مزوّد الطاقة", "Reset the power supply", "دابینکەری کارەبا ڕێکبخەرەوە"),
          t3(
            "افصل كيبل الطاقة من الجهاز، انتظر نصف دقيقة، ثم صِله بمقبس جداري مباشرة.",
            "Unplug the power cord from the console, wait half a minute, then plug it straight into a wall outlet.",
            "کێبڵی کارەبا لە ئامێرەکە بپچڕێنە، نیو خولەک چاوەڕێ بکە، پاشان ڕاستەوخۆ بە پریزی دیوار بیبەستە.",
          ),
        ),
        step(
          t3("استخدم زر الجهاز", "Use the console's own button", "دوگمەی خودی ئامێرەکە بەکاربهێنە"),
          t3(
            "اضغط زر Xbox في واجهة الجهاز نفسه، لا زر اليد.",
            "Press the Xbox button on the front of the console itself, not the one on the controller.",
            "دوگمەی Xbox لە ڕووی پێشەوەی خودی ئامێرەکە داگرە، نەک هی دەسکەکە.",
          ),
        ),
        step(
          t3("دعه يبرد", "Let it cool", "بیهێڵە سارد ببێتەوە"),
          t3(
            "إن اشتغل ثم انطفأ، تأكد أن فتحات التهوية مكشوفة واتركه ساعة قبل المحاولة من جديد.",
            "If it turns on and then shuts off, make sure the vents are uncovered and leave it for an hour before trying again.",
            "ئەگەر داگیرسا و پاشان کوژایەوە، دڵنیا بە کونەکانی هەواگۆڕکێ کراوەن و کاتژمێرێک بیهێڵەوە پێش هەوڵدانەوە.",
          ),
        ),
      ),
      h2(t3("الجهاز معلّق أو بطيء", "The console is frozen or slow", "ئامێرەکە وەستاوە یان خاوە")),
      steps(
        step(
          t3("أطفئه بالكامل", "Switch it off completely", "بە تەواوی بیکوژێنەوە"),
          t3(
            "اضغط زر Xbox في واجهة الجهاز مطولاً نحو 10 ثوانٍ حتى ينطفئ.",
            "Hold the Xbox button on the front of the console for about 10 seconds until it switches off.",
            "دوگمەی Xbox لە ڕووی پێشەوەی ئامێرەکە نزیکەی 10 چرکە داگرە تا دەکوژێتەوە.",
          ),
        ),
        step(
          t3("افصل الكهرباء ثم شغّله", "Unplug, then switch on", "کارەبا بپچڕێنە و پاشان دایبگیرسێنە"),
          t3(
            "افصل كيبل الطاقة نصف دقيقة، أعد توصيله، ثم شغّل الجهاز.",
            "Unplug the power cord for half a minute, plug it back in, then switch the console on.",
            "کێبڵی کارەبا نیو خولەک بپچڕێنە، دووبارە بیبەستەوە، پاشان ئامێرەکە داگیرسێنە.",
          ),
        ),
      ),
      h2(t3("لا توجد صورة", "No picture", "وێنە نییە")),
      ul(
        t3(
          "تأكد أن كيبل HDMI في منفذ HDMI OUT خلف الجهاز، وجرّب مدخلاً آخر في التلفاز.",
          "Check that the HDMI cable is in the HDMI OUT port on the back of the console, and try another input on the TV.",
          "دڵنیا بە کێبڵی HDMI لە دەرچەی HDMI OUT لە پشتی ئامێرەکەدایە، و دەرچەیەکی تر لە تەلەفزیۆنەکە تاقی بکەرەوە.",
        ),
        t3(
          "استخدم كيبل HDMI المرفق مع الجهاز.",
          "Use the HDMI cable that came with the console.",
          "ئەو کێبڵە HDMIـە بەکاربهێنە کە لەگەڵ ئامێرەکە هاتووە.",
        ),
      ),
      h2(t3("اليد لا تتصل", "The controller will not connect", "دەسکەکە نابەسترێت")),
      ul(
        t3("بدّل البطاريتين.", "Replace both batteries.", "هەردوو پاترییەکە بگۆڕە."),
        t3(
          "اضغط زر الاقتران في الجهاز، ثم زر الاقتران أعلى اليد حتى يثبت ضوء زر Xbox.",
          "Press the pair button on the console, then the pair button on top of the controller until the Xbox button light stays on.",
          "دوگمەی جووتکردن لە ئامێرەکە داگرە، پاشان دوگمەی جووتکردن لە سەرەوەی دەسکەکە تا ڕووناکیی دوگمەی Xbox جێگیر دەبێت.",
        ),
        t3(
          "صِل اليد بكيبل USB-C للتأكد من أنها تعمل.",
          "Connect the controller with a USB-C cable to check that it works.",
          "دەسکەکە بە کێبڵی USB-C ببەستە بۆ دڵنیابوون لەوەی کاردەکات.",
        ),
      ),
      POWER_SUPPLY_DANGER,
      BOOK_REPAIR,
    ],
  },
  {
    slug: "handheld-pc-first-setup",
    kind: "setup",
    title: t3(
      "تجهيز حاسوب الألعاب المحمول لأول مرة",
      "Setting up your handheld gaming PC for the first time",
      "ئامادەکردنی کۆمپیوتەری یاریی دەستی بۆ یەکەم جار",
    ),
    summary: t3(
      "خطوات تنطبق على Steam Deck و ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw: الشحن، التحديثات، التخزين والعناية بالبطارية.",
      "Steps that apply to Steam Deck, ROG Ally, ROG Xbox Ally, Legion Go and MSI Claw: charging, updates, storage and battery care.",
      "هەنگاوانێک کە بۆ Steam Deck و ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw دەگونجێن: بارگاویکردن، نوێکردنەوەکان، بیرگە و چاودێریی پاتری.",
    ),
    platform: "handheld",
    tags: ["setup", "handheld-pc", "battery"],
    blocks: [
      devicePhoto("steam-deck-oled--1", "Steam Deck OLED"),
      H_STEPS,
      steps(
        step(
          t3("اشحنه بالشاحن الأصلي", "Charge it with the original charger", "بە بارگاویکەری ئەسڵی بارگاوی بکە"),
          t3(
            "صِل الشاحن المرفق قبل أول تشغيل؛ بعض الأجهزة لا تقلع من العلبة إلا وهي على الشاحن.",
            "Plug in the included charger before the first start; some devices will not boot out of the box unless they are on the charger.",
            "پێش یەکەم داگیرساندن بارگاویکەری هاوپێچ ببەستە؛ هەندێک ئامێر لە قوتووەوە داناگیرسێن مەگەر لەسەر بارگاویکەر بن.",
          ),
        ),
        step(
          t3("أكمل إعداد النظام", "Finish the system setup", "ئامادەکردنی سیستەم تەواو بکە"),
          t3(
            "يطلب Steam Deck ونسخة SteamOS من Legion Go S حساب Steam. أجهزة Windows مثل ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw تبدأ بإعداد Windows 11.",
            "Steam Deck and the SteamOS edition of Legion Go S ask for a Steam account. Windows devices such as ROG Ally, ROG Xbox Ally, Legion Go and MSI Claw start with Windows 11 setup.",
            "Steam Deck و وەشانی SteamOSـی Legion Go S داوای هەژماری Steam دەکەن. ئامێرەکانی Windows وەک ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw بە ئامادەکردنی Windows 11 دەست پێدەکەن.",
          ),
        ),
        step(
          t3("ثبّت التحديثات كلها", "Install all updates", "هەموو نوێکردنەوەکان دابمەزرێنە"),
          t3(
            "في Steam Deck من الإعدادات ثم النظام. في أجهزة Windows شغّل Windows Update، ثم حدّث تطبيق الشركة (Armoury Crate SE أو Legion Space أو MSI Center M). أبقِ الجهاز على الشاحن أثناء أي تحديث للـ BIOS ولا تطفئه.",
            "On Steam Deck, go to Settings, then System. On Windows devices run Windows Update, then update the maker's app (Armoury Crate SE, Legion Space or MSI Center M). Keep the device on its charger during any BIOS update and do not switch it off.",
            "لە Steam Deck لە ڕێکخستنەکان و پاشان سیستەم. لە ئامێرەکانی Windows، Windows Update کارپێبکە، پاشان ئەپی کۆمپانیاکە نوێ بکەرەوە (Armoury Crate SE یان Legion Space یان MSI Center M). لە کاتی هەر نوێکردنەوەیەکی BIOSدا ئامێرەکە لەسەر بارگاویکەر بهێڵەوە و مەیکوژێنەوە.",
          ),
        ),
        step(
          ADD_STORAGE,
          t3(
            "أدخل بطاقة microSD في فتحتها، ثم هيّئها من إعدادات التخزين في النظام.",
            "Insert a microSD card into its slot, then format it from the system's storage settings.",
            "کارتێکی microSD بخە شوێنەکەی، پاشان لە ڕێکخستنەکانی بیرگەی سیستەمەوە فۆرماتی بکە.",
          ),
        ),
        step(
          t3("اضبط الأداء", "Set the performance mode", "دۆخی توانا ڕێکبخە"),
          t3(
            "اختر وضع أداء أهدأ للألعاب الخفيفة؛ يطيل عمر الشحنة ويخفف الحرارة.",
            "Choose a quieter performance mode for light games; it stretches the battery and reduces heat.",
            "بۆ یارییە سووکەکان دۆخێکی توانای هێمنتر هەڵبژێرە؛ ماوەی پاتری درێژ دەکاتەوە و گەرمی کەم دەکاتەوە.",
          ),
        ),
      ),
      h2(t3("العناية بالبطارية", "Battery care", "چاودێریی پاتری")),
      ul(
        t3(
          "لا تترك الجهاز فارغاً تماماً لأسابيع؛ اشحنه إلى النصف تقريباً قبل تخزينه.",
          "Do not leave the device completely empty for weeks; charge it to about half before storing it.",
          "ئامێرەکە بۆ چەند هەفتەیەک بە تەواوی بەتاڵ مەهێڵەوە؛ پێش هەڵگرتنی نزیکەی تا نیوە بارگاوی بکە.",
        ),
        t3("لا تتركه في السيارة أو تحت الشمس.", "Do not leave it in a car or in direct sun.", "لە ناو ئۆتۆمبێل یان لەژێر خۆردا مەیهێڵەوە."),
        t3(
          "لا تسدّ فتحات التهوية بيدك أو بغطاء أثناء اللعب.",
          "Do not block the vents with your hand or a cover while playing.",
          "لە کاتی یاریدا کونەکانی هەواگۆڕکێ بە دەست یان بە بەرگ مەگرە.",
        ),
      ),
      callout(
        "warning",
        t3(
          "استبدال البطارية أو فتح الجهاز عمل للفني. إذا انتفخ ظهر الجهاز أو ارتفعت الشاشة عن إطارها فأوقف استخدامه وشحنه واحجز صيانة.",
          "Replacing the battery or opening the device is work for a technician. If the back swells or the screen lifts from its frame, stop using and charging it and book a repair.",
          "گۆڕینی پاتری یان کردنەوەی ئامێرەکە کاری تەکنیکارە. ئەگەر پشتی ئامێرەکە ئاوسا یان شاشەکە لە چوارچێوەکەی بەرز بووەوە، بەکارهێنان و بارگاویکردنی بوەستێنە و چاککردنەوە تۆمار بکە.",
        ),
        SAFETY,
      ),
    ],
  },
  {
    slug: "handheld-pc-safe-troubleshooting",
    kind: "troubleshooting",
    title: t3(
      "حواسيب الألعاب المحمولة: حلول آمنة للمشكلات الشائعة",
      "Handheld gaming PCs: safe fixes for common problems",
      "کۆمپیوتەری یاریی دەستی: چارەسەری سەلامەت بۆ کێشە باوەکان",
    ),
    summary: t3(
      "الجهاز لا يشتغل، يسخن، أو العصا لا تستجيب: خطوات آمنة لـ Steam Deck و ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw.",
      "The device will not turn on, runs hot, or a stick does not respond: safe steps for Steam Deck, ROG Ally, ROG Xbox Ally, Legion Go and MSI Claw.",
      "ئامێرەکە داناگیرسێت، گەرم دەبێت، یان جۆیستیک وەڵام ناداتەوە: هەنگاوی سەلامەت بۆ Steam Deck و ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw.",
    ),
    platform: "handheld",
    tags: ["troubleshooting", "power", "overheating", "stick-drift", "handheld-pc"],
    blocks: [
      SAFE_SCOPE,
      H_NO_POWER,
      steps(
        step(
          t3("اشحنه 30 دقيقة", "Charge it for 30 minutes", "30 خولەک بارگاوی بکە"),
          t3(
            "استخدم الشاحن الأصلي ولاحظ ضوء الشحن.",
            "Use the original charger and watch for the charging light.",
            "بارگاویکەری ئەسڵی بەکاربهێنە و سەیری ڕووناکیی بارگاویکردن بکە.",
          ),
        ),
        step(
          t3("أعد تشغيله بالقوة", "Force a restart", "بە زۆر دایبگیرسێنەوە"),
          t3(
            "اضغط زر التشغيل مطولاً من 10 إلى 15 ثانية، اتركه، ثم اضغطه مرة واحدة.",
            "Hold the power button for 10 to 15 seconds, release it, then press it once.",
            "دوگمەی داگیرساندن 10 تا 15 چرکە داگرە، بەریبدە، پاشان یەک جار دایبگرە.",
          ),
        ),
        step(
          t3("جرّب شاحناً آخر", "Try another charger", "بارگاویکەرێکی تر تاقی بکەرەوە"),
          t3(
            "إن لم يظهر ضوء الشحن فجرّب شاحن USB-C آخر بقدرة لا تقل عن قدرة الشاحن الأصلي.",
            "If the charging light does not come on, try another USB-C charger with at least the power of the original.",
            "ئەگەر ڕووناکیی بارگاویکردن دەرنەکەوت، بارگاویکەرێکی تری USB-C تاقی بکەرەوە کە توانای لە هی ئەسڵییەکە کەمتر نەبێت.",
          ),
        ),
      ),
      h2(t3("حرارة أو صوت مروحة مرتفع", "Heat or a loud fan", "گەرمی یان دەنگی بەرزی پانکە")),
      ul(
        t3(
          "تأكد أن فتحات التهوية غير مسدودة ونظّفها من الخارج بلطف.",
          "Check that the vents are not blocked and gently clean them from the outside.",
          "دڵنیا بە کونەکانی هەواگۆڕکێ نەگیراون و لە دەرەوە بە نەرمی پاکیان بکەرەوە.",
        ),
        t3(
          "اخفض وضع الأداء أو حدّد معدل الإطارات.",
          "Lower the performance mode or cap the frame rate.",
          "دۆخی توانا کەم بکەرەوە یان ڕێژەی فرەیم سنووردار بکە.",
        ),
        t3("حدّث النظام وتعريفات الجهاز.", "Update the system and the device drivers.", "سیستەم و درایڤەرەکانی ئامێرەکە نوێ بکەرەوە."),
      ),
      h2(t3("العصا أو الأزرار لا تستجيب كما يجب", "A stick or the buttons do not respond properly", "جۆیستیک یان دوگمەکان بە باشی وەڵام نادەنەوە")),
      p(
        t3(
          `أعد تشغيل الجهاز وحدّث النظام، ثم استخدم أداة المعايرة في إعدادات الجهاز أو تطبيق الشركة. إن استمرت المشكلة فاستخدم التشخيص الموجَّه «${STICK_DRIFT_TREE.ar}».`,
          `Restart the device and update the system, then use the calibration tool in the device settings or the maker's app. If the problem stays, use the guided diagnosis “${STICK_DRIFT_TREE.en}”.`,
          `ئامێرەکە دابگیرسێنەوە و سیستەم نوێ بکەرەوە، پاشان ئامرازی پێوانەکردنەوە لە ڕێکخستنەکانی ئامێرەکە یان ئەپی کۆمپانیاکە بەکاربهێنە. ئەگەر کێشەکە بەردەوام بوو، دەستنیشانکردنی ڕێنماییکراوی «${STICK_DRIFT_TREE.ckb}» بەکاربهێنە.`,
        ),
      ),
      BATTERY_DANGER,
      BOOK_REPAIR,
    ],
  },
];

/** Title of the stick-drift tree as the articles quote it (kept in step by tests). */
export const STICK_DRIFT_TREE_TITLE: T3 = STICK_DRIFT_TREE;
