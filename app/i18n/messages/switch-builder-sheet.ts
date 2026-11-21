import { defineMessages } from "../translate";

/**
 * "switch-builder-sheet" — the Switch bundle builder's game details sheet, its trailer and its spotlight guide
 * (app/routes/storefront/builder/components/{GameSheet,TrailerEmbed,BuilderTour,SpotlightTour}.tsx; contract
 * docs/switch-builder.md §6.5–6.7). Loaded by the builder's route loader with "switch-builder" (genre and play-mode
 * labels: `genre.<key>`, `mode.<key>` belong to that namespace; the guide quotes the page's own key names from there:
 * `{have}` = device.have, `{none}` = memory.none).
 *
 * Copy voice: docs/DESIGN.md §11 — plain, specific, active; a key says what it does; no exclamation marks; Latin brand
 * names stay Latin. Sizes are «GB» as the console shows them. Games are bought as TamTam cartridges or on the Nintendo
 * eShop with eShop cards: nothing here may suggest that a game comes on a card or a console — a game is CHOSEN for the
 * plan (the grid's own verb), never "added to" or "put on" the console. «الجهاز» / «ئامێر» is the console: the shopper's
 * phone or computer is «هذا المتصفح» / «ئەم وێبگەڕە». The Sorani column must be reviewed by a native reader before
 * launch; in it no suffix follows a Latin name or a figure (a right-to-left line draws it on the wrong side).
 */
export default defineMessages({
  ar: {
    sheet: {
      picture: "صورة {title}",
      tags: "النوع وطريقة اللعب",
      loading: "نحمّل وصف اللعبة",
      detailsError: "تعذّر تحميل وصف اللعبة.",
      detailsErrorText: "باقي التفاصيل هنا. أعد المحاولة لتحميل الوصف.",
    },
    size: {
      title: "المساحة على الجهاز",
      digital: "النسخة الرقمية",
      digitalHint: "اللعبة مع آخر تحديث، بلا محتوى إضافي",
      cartridge: "الشريط",
      cartridgeHint: "ما تنزّله نسخة الشريط على الجهاز: آخر تحديث، بلا محتوى إضافي",
      cartridgeFull: "نحسبه بالحجم الكامل حتى نقيس الشريط",
      missing: "لم يُضف بعد",
      asOf: "قسنا الحجم على أجهزة طمطم بتاريخ {date}.",
      why: "الرقم هو حجم اللعبة بعد تثبيت آخر تحديث، لذلك قد يكون أكبر من حجم التنزيل الأول.",
      saves: "ملفات الحفظ لا تُحسب: يحفظها Switch دائماً في ذاكرة الجهاز، لا على بطاقة الذاكرة.",
      unsized: "لم نضف حجم هذه اللعبة بعد، فلا يمكن أن تدخل في حساب المساحة.",
    },
    fit: {
      fits: "تتّسع: يبقى بعدها {left}.",
      chosen: "مختارة: تأخذ {need}.",
      chosenLeft: "مختارة: تأخذ {need}، ويبقى {left}.",
      full: "لا تتّسع: تحتاج {need}، والمتبقي {left}.",
      unsized: "لم يُضف حجمها بعد، فلا يمكن اختيارها.",
    },
    format: {
      legend: "كيف ستشتريها",
      cartridge: "شريط من طمطم",
      digital: "نسخة رقمية من eShop",
      takes: "تأخذ {size} على الجهاز",
      cartridgeTakes: "يأخذ {size} على الجهاز للتحديثات",
      cartridgeFull: "نحسبه {size}، بالحجم الكامل، حتى نقيسه",
      noSize: "لم يُضف حجمها بعد",
      noRoom: "لا تتّسع: تحتاج {need}، والمتبقي {left}",
      outOfStock: "نفد حالياً",
      unavailable: "غير متوفر في طمطم حالياً",
    },
    price: {
      eshop: "سعر النسخة الرقمية في Nintendo eShop الأمريكي: {price}، بتاريخ {date}.",
      eshopUndated: "سعر النسخة الرقمية في Nintendo eShop الأمريكي: {price}.",
      eshopMissing: "لم نضف سعر النسخة الرقمية بعد. تجده في صفحتها على Nintendo eShop.",
    },
    score: {
      title: "تقييم Metacritic",
      line: "Metacritic {score}",
      reviews: { one: "مراجعة واحدة", two: "مراجعتان", few: "{n} مراجعات", many: "{n} مراجعة", other: "{n} مراجعة" },
      asOf: "بتاريخ {date}",
      link: "اعرضه على Metacritic",
    },
    about: {
      title: "عن اللعبة",
      wikipedia: "النص من مقالة {article} على Wikipedia، ومتاح بترخيص {licence}.",
      english: "لا يوجد وصف بالعربية بعد، فهذا الوصف بالإنجليزية.",
    },
    trailer: {
      title: "العرض الدعائي",
      play: "شغّل العرض الدعائي",
      frame: "العرض الدعائي للعبة {title} على YouTube",
      privacy: "يُحمَّل الفيديو من YouTube فقط عندما تضغط تشغيل.",
      offline: "لا يوجد اتصال. شغّل العرض الدعائي عند عودة الاتصال.",
    },
    links: {
      title: "روابط",
      eshop: "صفحتها في Nintendo eShop الأمريكي",
      metacritic: "صفحتها على Metacritic",
      wikipedia: "مقالتها على Wikipedia",
    },
    foot: {
      add: "اختر هذه اللعبة",
      remove: "أزلها من ألعابك",
      added: "اخترت {title}.",
      removed: "أزلت {title} من ألعابك.",
    },
    tour: {
      label: "دليل الصفحة",
      count: "{n} من {total}",
      next: "التالي",
      back: "السابق",
      skip: "تخطَّ",
      finish: "أنهِ الدليل",
      highlighted: "الجزء المُضاء من الصفحة: {name}",
      part: {
        steps: {
          title: "أربع خطوات",
          text: "تختار الجهاز، ثم بطاقة الذاكرة، ثم الألعاب، ثم تراجع كل شيء قبل أن تضيفه إلى السلة.",
        },
        deviceMode: {
          title: "جهاز جديد أو جهازك",
          text: "اشترِ جهازاً من طمطم ليدخل السلة، أو اختر «{have}» لتحسب مساحته فقط. ذاكرة الجهاز نفسها تدخل في الحساب في الحالتين.",
        },
        deviceList: {
          title: "الطراز",
          text: "الطراز يحدد ذاكرة الجهاز: في OLED مساحة أكبر من الطرازين الآخرين، وجهاز Switch Lite يُلعب باليد فقط، بلا تلفاز. السعر واللون والتوفّر كما هي الآن في طمطم.",
        },
        continue: {
          title: "الخطوة التالية",
          text: "اضغط هنا عندما تنتهي من الخطوة لتنتقل إلى التالية. اختياراتك محفوظة في هذا المتصفح.",
        },
        help: {
          title: "الدليل في أي وقت",
          text: "اضغط هذا الزر في أي خطوة لترى شرحها مرة أخرى.",
        },
        cardList: {
          title: "بطاقة الذاكرة",
          text: "تُحفظ الألعاب في ذاكرة الجهاز وعلى بطاقة microSD. اختر الحجم الذي تريده، أو «{none}» إذا كانت ذاكرة الجهاز تكفيك. يبقى الحجم الذي لا نبيعه الآن متاحاً للتخطيط.",
        },
        cardUsable: {
          title: "لماذا أقل من الرقم المكتوب",
          text: "تُباع البطاقات بالغيغابايت العشري، والجهاز يحسب كل غيغابايت 1024 ميغابايت، فتظهر بطاقة {label} عليه بنحو {shown}، ويذهب جزء صغير منها للتهيئة. ونترك جزءاً من البطاقة فارغاً لتحديثات الألعاب القادمة. لذلك الرقم بجانب كل حجم هو ما يبقى للألعاب فعلاً.",
        },
        cardOwned: {
          title: "عندك بطاقة",
          text: "فعّله إذا كانت عندك بطاقة بهذا الحجم: نحسب مساحتها ولا نضيفها إلى السلة.",
        },
        meter: {
          title: "المساحة",
          text: "يبيّن هذا المقياس ما تأخذه الألعاب التي اخترتها، وما نتركه فارغاً للتحديثات، وما يبقى. يتغيّر لونه كلما اقترب من الامتلاء، ولا تدخل لعبة لا تتّسع.",
        },
        search: {
          title: "ابحث",
          text: "اكتب اسم اللعبة بالعربية أو بالإنجليزية، أو اسم ناشرها.",
        },
        filters: {
          title: "الفلاتر والترتيب",
          text: "اعرض الألعاب حسب النوع وطريقة اللعب والحجم والسعر، أو اعرض فقط ما يتّسع في المساحة المتبقية.",
        },
        gameCard: {
          title: "اضغط لتختار، واضغط مطوّلاً للتفاصيل",
          text: "اضغط اللعبة مرة لتختارها، ومرة ثانية لتزيلها. اضغطها مطوّلاً لتفتح تفاصيلها: الوصف والعرض الدعائي والحجم.",
        },
        gameSize: {
          title: "الحجم الكامل",
          text: "هذا حجم اللعبة بعد تثبيت آخر تحديث كما قسناه على أجهزة طمطم، لا حجم التنزيل الأول فقط. اللعبة التي لم نضف حجمها بعد لا تدخل في الحساب.",
        },
        gameInfo: {
          title: "التفاصيل بلا ضغط مطوّل",
          text: "زر المعلومات يفتح التفاصيل نفسها، ومن لوحة المفاتيح أيضاً.",
        },
        chosen: {
          title: "ألعابك",
          text: "هنا الألعاب التي اخترتها وحجم كل واحدة، ومن هنا تزيل ما لا تريده.",
        },
        reviewLines: {
          title: "ما في خطتك",
          text: "كل سطر جزء من خطتك: ما نبيعه الآن يدخل السلة بسعره، ويظهر هنا أيضاً ما عندك من جهاز أو بطاقة، والألعاب الرقمية التي تشتريها من eShop. الإجمالي يجمع ما يمكن طلبه الآن فقط.",
        },
        reviewNotes: {
          title: "قبل أن تضيف إلى السلة",
          text: "هنا ما لا نبيعه الآن، والألعاب التي لم نُضف سعرها بعد، وطريقة شراء الألعاب الرقمية: تضيف قيمة بطاقة eShop إلى حساب Nintendo أمريكي، ثم تشتري اللعبة من eShop بنفسك.",
        },
        addAll: {
          title: "أضف الكل مرة واحدة",
          text: "يضيف كل ما يمكن طلبه إلى السلة معاً. إذا تعذّر سطر واحد لا يُضاف شيء، ونقول لك السبب.",
        },
      },
    },
  },
  en: {
    sheet: {
      picture: "{title} picture",
      tags: "Genre and play modes",
      loading: "Loading the description",
      detailsError: "The game's description could not be loaded.",
      detailsErrorText: "The other details are here. Try again to load the description.",
    },
    size: {
      title: "Space on the console",
      digital: "Digital copy",
      digitalHint: "The game with its latest update, without DLC",
      cartridge: "Cartridge",
      cartridgeHint: "What the cartridge copy downloads to the console: its latest update, without DLC",
      cartridgeFull: "Counted at the full size until we measure the cartridge",
      missing: "Not added yet",
      asOf: "We measured the size on TamTam consoles on {date}.",
      why: "This is the game's size after its latest update is installed, so it can be bigger than the first download.",
      saves: "Save files do not count: Switch always keeps them in the console's memory, never on the memory card.",
      unsized: "We have not added this game's size yet, so it cannot be counted in your space.",
    },
    fit: {
      fits: "Fits: {left} left after it.",
      chosen: "Chosen: takes {need}.",
      chosenLeft: "Chosen: takes {need}, {left} left.",
      full: "Does not fit: it needs {need} and {left} is left.",
      unsized: "Its size is not added yet, so it cannot be chosen.",
    },
    format: {
      legend: "How you buy it",
      cartridge: "TamTam cartridge",
      digital: "Digital copy from the eShop",
      takes: "Takes {size} on the console",
      cartridgeTakes: "Takes {size} on the console for updates",
      cartridgeFull: "Counted at the full {size} until we measure it",
      noSize: "Size not added yet",
      noRoom: "Does not fit: it needs {need} and {left} is left",
      outOfStock: "Sold out",
      unavailable: "Not available at TamTam right now",
    },
    price: {
      eshop: "Digital price on the US Nintendo eShop: {price}, as of {date}.",
      eshopUndated: "Digital price on the US Nintendo eShop: {price}.",
      eshopMissing: "We have not added the digital price yet. You can find it on its Nintendo eShop page.",
    },
    score: {
      title: "Metacritic score",
      line: "Metacritic {score}",
      reviews: { one: "{n} review", other: "{n} reviews" },
      asOf: "as of {date}",
      link: "See it on Metacritic",
    },
    about: {
      title: "About the game",
      wikipedia: "Text from the Wikipedia article {article}, available under {licence}.",
      english: "This description is in English: there is none in this language yet.",
    },
    trailer: {
      title: "Trailer",
      play: "Play the trailer",
      frame: "{title} trailer on YouTube",
      privacy: "The video loads from YouTube only when you press play.",
      offline: "No connection. Play the trailer when you are back online.",
    },
    links: {
      title: "Links",
      eshop: "Its page on the US Nintendo eShop",
      metacritic: "Its page on Metacritic",
      wikipedia: "Its Wikipedia article",
    },
    foot: {
      add: "Choose this game",
      remove: "Remove it from your games",
      added: "{title} chosen.",
      removed: "{title} removed from your games.",
    },
    tour: {
      label: "Page guide",
      count: "{n} of {total}",
      next: "Next",
      back: "Back",
      skip: "Skip",
      finish: "Finish the guide",
      highlighted: "The lit part of the page: {name}",
      part: {
        steps: {
          title: "Four steps",
          text: "Choose the console, then the memory card, then the games, then review everything before you add it to your cart.",
        },
        deviceMode: {
          title: "A new console or yours",
          text: "Buy a console from TamTam and it goes in your cart, or choose “{have}” to plan its space only. The console's own memory counts either way.",
        },
        deviceList: {
          title: "The model",
          text: "The model sets the console's memory: the OLED has more room than the other two, and the Switch Lite is handheld only, with no TV. Price, colour and availability are as they are at TamTam now.",
        },
        continue: {
          title: "The next step",
          text: "Press here when you are done with a step to go to the next one. Your choices are kept in this browser.",
        },
        help: {
          title: "The guide, any time",
          text: "Press this key on any step to see its guide again.",
        },
        cardList: {
          title: "The memory card",
          text: "Games are stored in the console's memory and on a microSD card. Choose the size you want, or “{none}” if the console's memory is enough. A size we do not sell now can still be chosen for planning.",
        },
        cardUsable: {
          title: "Why less than the label",
          text: "Cards are sold in decimal gigabytes, while the console counts 1024 megabytes to a gigabyte, so a {label} card shows about {shown}, and formatting takes a little more. We also keep part of the card free for future game updates. That is why the figure next to each size is what games can really use.",
        },
        cardOwned: {
          title: "Already have a card",
          text: "Turn this on if you have a card of this size: we count its space and leave it out of your cart.",
        },
        meter: {
          title: "Space",
          text: "This bar shows what your chosen games take, what we keep free for updates, and what is left. Its colour changes as it fills up, and a game that does not fit cannot join.",
        },
        search: {
          title: "Search",
          text: "Type a game's name in Arabic or English, or its publisher.",
        },
        filters: {
          title: "Filters and sort",
          text: "Filter games by genre, play mode, size and price, or show only what fits in the space left.",
        },
        gameCard: {
          title: "Tap to choose, hold for details",
          text: "Tap a game once to choose it and again to remove it. Press and hold it to open its details: description, trailer and size.",
        },
        gameSize: {
          title: "The full size",
          text: "This is the game's size after its latest update, as measured on TamTam consoles, not just the first download. A game whose size we have not added yet cannot be planned.",
        },
        gameInfo: {
          title: "Details without holding",
          text: "The info key opens the same details, from the keyboard too.",
        },
        chosen: {
          title: "Your games",
          text: "Here are the games you chose, with each one's size, and you can remove any of them here.",
        },
        reviewLines: {
          title: "In your plan",
          text: "Each line is part of your plan: what TamTam sells now goes in the cart at its price; your own console or card and the digital games you buy on the eShop are listed too. The total adds up only what can be ordered now.",
        },
        reviewNotes: {
          title: "Before you add to the cart",
          text: "Here is what we do not sell right now, the games we have not priced yet, and how digital games are bought: you redeem the eShop card on a US Nintendo Account, then buy the game on the eShop yourself.",
        },
        addAll: {
          title: "Add everything at once",
          text: "Adds everything that can be ordered to your cart together. If one line cannot be added, nothing is added and we tell you why.",
        },
      },
    },
  },
  ckb: {
    sheet: {
      picture: "وێنەی {title}",
      tags: "جۆر و شێوەی یاریکردن",
      loading: "وەسفی یارییەکە بار دەکەین",
      detailsError: "نەتوانرا وەسفی یارییەکە بار بکرێت.",
      detailsErrorText: "وردەکارییەکانی تر لێرەن. دووبارە هەوڵ بدەوە بۆ بارکردنی وەسفەکە.",
    },
    size: {
      title: "شوێن لەسەر ئامێرەکە",
      digital: "کۆپیی دیجیتاڵ",
      digitalHint: "یارییەکە لەگەڵ دوایین نوێکردنەوە، بەبێ ناوەڕۆکی زیادە",
      cartridge: "کارتریج",
      cartridgeHint: "ئەوەی کۆپیی کارتریج دایدەبەزێنێتە سەر ئامێرەکە: دوایین نوێکردنەوە، بەبێ ناوەڕۆکی زیادە",
      cartridgeFull: "تا کارتریجەکە دەپێوین، بە قەبارەی تەواو حیسابی دەکەین",
      missing: "هێشتا زیاد نەکراوە",
      asOf: "قەبارەکەمان لەسەر ئامێرەکانی طمطم لە {date} پێوا.",
      why: "ئەم ژمارەیە قەبارەی یارییەکەیە دوای دامەزراندنی دوایین نوێکردنەوە، بۆیە لەوانەیە لە یەکەم داگرتن گەورەتر بێت.",
      saves: "فایلەکانی پاشەکەوتکردن حیساب ناکرێن: Switch هەمیشە لە بیرگەی ئامێرەکەدا هەڵیاندەگرێت، نەک لەسەر کارتی بیرگە.",
      unsized: "هێشتا قەبارەی ئەم یارییەمان زیاد نەکردووە، بۆیە ناچێتە ناو حیسابی شوێنەکەوە.",
    },
    fit: {
      fits: "جێی دەبێتەوە: دوای ئەو {left} دەمێنێتەوە.",
      chosen: "هەڵبژێردراوە: {need} دەبات.",
      chosenLeft: "هەڵبژێردراوە: {need} دەبات و {left} دەمێنێتەوە.",
      full: "جێی نابێتەوە: پێویستی بە {need} هەیە و {left} ماوە.",
      unsized: "هێشتا قەبارەکەی زیاد نەکراوە، بۆیە ناتوانرێت هەڵبژێردرێت.",
    },
    format: {
      legend: "چۆن دەیکڕیت",
      cartridge: "کارتریج لە طمطم",
      digital: "کۆپیی دیجیتاڵ لە eShop",
      takes: "{size} لەسەر ئامێرەکە دەبات",
      cartridgeTakes: "{size} لەسەر ئامێرەکە دەبات بۆ نوێکردنەوەکان",
      cartridgeFull: "تا دەیپێوین بە قەبارەی تەواو {size} حیساب دەکرێت",
      noSize: "هێشتا قەبارەکەی زیاد نەکراوە",
      noRoom: "جێی نابێتەوە: پێویستی بە {need} هەیە و {left} ماوە",
      outOfStock: "ئێستا نەماوە",
      unavailable: "ئێستا لە طمطم بەردەست نییە",
    },
    price: {
      eshop: "نرخی کۆپیی دیجیتاڵ لە فرۆشگای ئەمریکیی Nintendo eShop: {price}، لە {date}.",
      eshopUndated: "نرخی کۆپیی دیجیتاڵ لە فرۆشگای ئەمریکیی Nintendo eShop: {price}.",
      eshopMissing: "هێشتا نرخی کۆپیی دیجیتاڵمان زیاد نەکردووە. لە پەڕەکەی لە Nintendo eShop دەیدۆزیتەوە.",
    },
    score: {
      title: "نمرەی Metacritic",
      line: "Metacritic {score}",
      reviews: { one: "یەک هەڵسەنگاندن", other: "{n} هەڵسەنگاندن" },
      asOf: "لە {date}",
      link: "لە Metacritic بیبینە",
    },
    about: {
      title: "دەربارەی یارییەکە",
      wikipedia: "دەقەکە لە وتاری {article} لە Wikipedia وەرگیراوە، و بە مۆڵەتی {licence} بەردەستە.",
      english: "هێشتا وەسفی کوردی نییە، بۆیە ئەم وەسفە بە ئینگلیزییە.",
    },
    trailer: {
      title: "ڤیدیۆی ناساندن",
      play: "ڤیدیۆی ناساندنەکە لێبدە",
      frame: "ڤیدیۆی ناساندنی {title} لە YouTube",
      privacy: "ڤیدیۆکە تەنها کاتێک لە YouTube بار دەبێت کە دوگمەی لێدان دادەگریت.",
      offline: "هێڵی ئینتەرنێت نییە. کاتێک هێڵ گەڕایەوە ڤیدیۆی ناساندنەکە لێبدە.",
    },
    links: {
      title: "بەستەرەکان",
      eshop: "پەڕەکەی لە فرۆشگای ئەمریکیی Nintendo eShop",
      metacritic: "پەڕەکەی لە Metacritic",
      wikipedia: "وتارەکەی لە Wikipedia",
    },
    foot: {
      add: "ئەم یارییە هەڵبژێرە",
      remove: "لە یارییەکانت لای ببە",
      added: "{title} هەڵبژێردرا.",
      removed: "{title} لە یارییەکانت لابرا.",
    },
    tour: {
      label: "ڕێنمایی پەڕەکە",
      count: "{n} لە {total}",
      next: "دواتر",
      back: "پێشوو",
      skip: "تێپەڕە",
      finish: "ڕێنماییەکە تەواو بکە",
      highlighted: "بەشی ڕووناککراوەی پەڕەکە: {name}",
      part: {
        steps: {
          title: "چوار هەنگاو",
          text: "ئامێرەکە هەڵدەبژێریت، پاشان کارتی بیرگە، پاشان یارییەکان، پاشان پێش ئەوەی بیخەیتە ناو سەبەتە هەموو شتێک پێدا دەچیتەوە.",
        },
        deviceMode: {
          title: "ئامێرێکی نوێ یان ئامێرەکەی خۆت",
          text: "ئامێرێک لە طمطم بکڕە تا بچێتە ناو سەبەتەکە، یان «{have}» هەڵبژێرە تا تەنها شوێنەکەی بژمێریت. بیرگەی خودی ئامێرەکە لە هەردوو حاڵەتدا حیساب دەکرێت.",
        },
        deviceList: {
          title: "مۆدێل",
          text: "مۆدێلەکە بیرگەی ئامێرەکە دیاری دەکات: OLED شوێنی زیاتری هەیە لە دوو مۆدێلەکەی تر، و ئامێری Switch Lite تەنها بە دەست یاری دەکرێت، بەبێ تەلەفزیۆن. نرخ و ڕەنگ و بەردەستبوون وەک ئەوەی ئێستا لە طمطم هەن.",
        },
        continue: {
          title: "هەنگاوی دواتر",
          text: "کاتێک هەنگاوێکت تەواو کرد لێرە دابگرە بۆ ئەوەی بچیتە هەنگاوی دواتر. هەڵبژاردنەکانت لەم وێبگەڕەدا دەمێننەوە.",
        },
        help: {
          title: "ڕێنمایی لە هەر کاتێکدا",
          text: "لە هەر هەنگاوێکدا ئەم دوگمەیە دابگرە بۆ ئەوەی ڕێنمایی ئەو هەنگاوە دووبارە ببینیتەوە.",
        },
        cardList: {
          title: "کارتی بیرگە",
          text: "یارییەکان لە بیرگەی ئامێرەکە و لەسەر کارتی microSD هەڵدەگیرێن. ئەو قەبارەیە هەڵبژێرە کە دەتەوێت، یان «{none}» ئەگەر بیرگەی ئامێرەکە بەسە. ئەو قەبارەیەی کە ئێستا نایفرۆشین هێشتا بۆ پلاندانان هەڵدەبژێردرێت.",
        },
        cardUsable: {
          title: "بۆچی کەمترە لە ژمارەی سەر کارتەکە",
          text: "کارتەکان بە گیگابایتی دەیی دەفرۆشرێن، بەڵام ئامێرەکە هەر گیگابایتێک بە 1024 مێگابایت حیساب دەکات، بۆیە کارتێکی {label} نزیکەی {shown} نیشان دەدات، و فۆرماتکردنیش بەشێکی کەمی دەبات. هەروەها بەشێک لە کارتەکە بۆ نوێکردنەوەکانی داهاتووی یارییەکان بەتاڵ دەهێڵینەوە. بۆیە ئەو ژمارەیەی لە تەنیشت هەر قەبارەیەکە ئەوەیە کە بە ڕاستی بۆ یارییەکان دەمێنێتەوە.",
        },
        cardOwned: {
          title: "کارتت هەیە",
          text: "ئەگەر کارتێکی بەم قەبارەیەت هەیە ئەمە چالاک بکە: شوێنەکەی حیساب دەکەین و نایخەینە ناو سەبەتەکەوە.",
        },
        meter: {
          title: "شوێن",
          text: "ئەم پێوەرە نیشانی دەدات یارییە هەڵبژێردراوەکانت چەند شوێن دەبەن، چەندێک بۆ نوێکردنەوەکان بەتاڵ دەهێڵینەوە، و چەند دەمێنێتەوە. ڕەنگەکەی دەگۆڕێت کاتێک لە پڕبوون نزیک دەبێتەوە، و یارییەک کە جێی نابێتەوە ناچێتە ناوەوە.",
        },
        search: {
          title: "گەڕان",
          text: "ناوی یارییەکە بە عەرەبی یان ئینگلیزی بنووسە، یان ناوی بڵاوکەرەوەکەی.",
        },
        filters: {
          title: "پاڵاوتن و ڕیزکردن",
          text: "یارییەکان بەپێی جۆر و شێوەی یاریکردن و قەبارە و نرخ بپاڵێوە، یان تەنها ئەوانە پیشان بدە کە لە شوێنی ماوەدا جێیان دەبێتەوە.",
        },
        gameCard: {
          title: "دابگرە بۆ هەڵبژاردن، ڕایگرە بۆ وردەکاری",
          text: "جارێک یارییەکە دابگرە بۆ هەڵبژاردنی، و جارێکی تر بۆ لابردنی. پەنجەت لەسەری ڕابگرە بۆ کردنەوەی وردەکارییەکانی: وەسف و ڤیدیۆی ناساندن و قەبارە.",
        },
        gameSize: {
          title: "قەبارەی تەواو",
          text: "ئەمە قەبارەی یارییەکەیە دوای دامەزراندنی دوایین نوێکردنەوە، وەک لەسەر ئامێرەکانی طمطم پێومانە، نەک تەنها یەکەم داگرتن. یارییەک کە هێشتا قەبارەکەیمان زیاد نەکردووە ناچێتە ناو حیسابەوە.",
        },
        gameInfo: {
          title: "وردەکاری بەبێ ڕاگرتن",
          text: "دوگمەی زانیاری هەمان وردەکاری دەکاتەوە، بە تەختەکلیلیش.",
        },
        chosen: {
          title: "یارییەکانت",
          text: "ئەو یارییانەی هەڵتبژاردوون لێرەن لەگەڵ قەبارەی هەر یەکێکیان، و لێرەوە هەر کامێکیان نەتەوێت لای دەبەیت.",
        },
        reviewLines: {
          title: "ئەوەی لە پلانەکەتدایە",
          text: "هەر هێڵێک بەشێکە لە پلانەکەت: ئەوەی ئێستا دەیفرۆشین بە نرخەکەیەوە دەچێتە ناو سەبەتە، و ئامێر یان کارتی خۆت و ئەو یارییە دیجیتاڵانەی لە eShop دەیانکڕیت لێرەش دیارن. کۆی گشتی تەنها ئەوە کۆ دەکاتەوە کە ئێستا داوا دەکرێت.",
        },
        reviewNotes: {
          title: "پێش ئەوەی بیخەیتە ناو سەبەتە",
          text: "لێرەدا ئەوەی ئێستا نایفرۆشین، ئەو یارییانەی هێشتا نرخیانمان زیاد نەکردووە، و چۆنیەتی کڕینی یارییە دیجیتاڵەکان هەیە: بە کارتی eShop باڵانسی هەژمارێکی ئەمریکیی Nintendo پڕ دەکەیتەوە، پاشان خۆت یارییەکە لە eShop دەکڕیت.",
        },
        addAll: {
          title: "هەمووی بە یەکجار زیاد بکە",
          text: "هەموو ئەوەی داوا دەکرێت پێکەوە دەخاتە ناو سەبەتەکە. ئەگەر یەک هێڵ زیاد نەکرا، هیچ شتێک زیاد ناکرێت و هۆکارەکەت پێ دەڵێین.",
        },
      },
    },
  },
});
