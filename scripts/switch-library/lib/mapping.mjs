/**
 * How Wikidata's vocabulary becomes the builder's (docs/switch-builder.md §4.1). Every table is keyed by Wikidata
 * item id, with the English label as a comment; built from the values the Switch items actually carry (discovery
 * queries of 2026-11-21: 33 item types, 268 genres, 15 game modes).
 *
 * Genres (P136) → GENRE_KEYS of app/lib/switch-builder/types.ts. A genre in GENRE_TABLE maps to its keys; any other
 * genre is walked up its "subclass of" (P279) chain to the NEAREST genre in the table (so "bowling video game" →
 * "sports video game" → sports) — at most GENRE_MAX_DEPTH steps. An empty list means "known, but none of our keys"
 * (themes and settings such as "science fiction video game", broad labels such as "casual game"). A game whose
 * genres all map to nothing gets "other"; a game with no P136 at all gets no genre (we do not know it).
 *
 * Item types (P31) decide what joins the library: video games and compilations stay; downloadable content,
 * expansions, series and esports disciplines go, and so does software that is not a game (apps, subscriptions,
 * streaming services, engines). Types are classified through P279 as well (TYPE_MAX_DEPTH steps).
 *
 * Game modes (P404) → PLAY_MODES. A co-operative or online mode also counts as "multi" (more than one player).
 */

/** Keep in step with GENRE_KEYS in app/lib/switch-builder/types.ts (checked by tests/switch-library-data.test.ts). */
export const GENRE_KEYS = ["action", "adventure", "platformer", "rpg", "puzzle", "racing", "sports", "fighting", "shooter", "simulation", "strategy", "party", "music", "horror", "other"];
/** Keep in step with PLAY_MODES in app/lib/switch-builder/types.ts. */
export const PLAY_MODES = ["single", "multi", "coop", "online"];

export const GENRE_MAX_DEPTH = 4;
export const TYPE_MAX_DEPTH = 8;

export const GENRE_TABLE = {
  Q270948: ["action"],                       // action game
  Q23916: ["adventure"],                     // adventure video game
  Q343568: ["action", "adventure"],          // action-adventure game
  Q1050023: [],                              // casual game
  Q744038: ["rpg"],                          // role-playing video game
  Q1610017: ["simulation"],                  // simulation video game
  Q828322: ["platformer"],                   // platform game
  Q54767: ["puzzle"],                        // puzzle video game
  Q472055: ["strategy"],                     // strategy video game
  Q689445: ["adventure"],                    // visual novel
  Q860750: ["racing"],                       // racing video game
  Q1422746: ["rpg", "action"],               // action role-playing game
  Q868217: ["sports"],                       // sports video game
  Q19643088: ["platformer", "action"],       // Metroidvania
  Q27670585: [],                             // science fiction video game
  Q11590806: ["adventure"],                  // point-and-click adventure
  Q1143132: [],                              // roguelike (too broad: action and role-playing games alike)
  Q115101598: [],                            // post-apocalyptic video game
  Q185029: ["shooter"],                      // first-person shooter
  Q333967: ["horror"],                       // survival horror
  Q1044478: ["shooter"],                     // shoot 'em up
  Q4282636: ["shooter"],                     // shooter game
  Q401831: ["action"],                       // beat 'em up
  Q846224: ["fighting"],                     // fighting game
  Q1529437: ["rpg", "strategy"],             // tactical role-playing game
  Q11338014: ["horror"],                     // horror video game
  Q7888616: ["party"],                       // party video game
  Q15613992: [],                             // arcade
  Q1163960: ["action"],                      // hack and slash
  Q2632782: ["music"],                       // rhythm game
  Q1199309: ["simulation"],                  // life simulation game
  Q25377002: ["puzzle"],                     // hidden object game
  Q5923834: ["rpg"],                         // Japanese role-playing video game
  Q105098453: [],                            // roguelite
  Q1223895: [],                              // side-scrolling video game (a view, not a genre)
  Q584105: ["music"],                        // music video game
  Q1198141: ["simulation"],                  // business simulation game
  Q21030988: [],                             // survival game
  Q380266: ["shooter"],                      // third-person shooter
  Q54323360: [],                             // cyberpunk video game
  Q2176159: ["strategy"],                    // turn-based strategy video game
  Q3177954: [],                              // pinball video game
  Q85341917: [],                             // LGBT-themed video game
  Q62591185: ["puzzle", "platformer"],       // puzzle-platformer
  Q2628513: ["adventure"],                   // graphic adventure game
  Q588289: ["simulation", "strategy"],       // city-building game
  Q1265717: ["rpg"],                         // dungeon crawl
  Q1049203: ["adventure"],                   // otome game
  Q85422949: [],                             // video game with LGBT character
  Q208189: ["strategy"],                     // real-time strategy
  Q858523: ["action"],                       // stealth game
  Q1137896: ["strategy"],                    // tower defense
  Q29471320: ["strategy"],                   // card video game
  Q25397095: [],                             // sandbox game
  Q8018891: ["adventure"],                   // romance adventure game
  Q42409239: [],                             // fantasy video game
  Q1046788: [],                              // eroge
  Q111149309: ["simulation"],                // farming simulation game
  Q48997688: ["strategy"],                   // collectible card video game
  Q19272838: [],                             // board video game
  Q1478420: ["sports"],                      // association football video game
  Q821157: ["shooter"],                      // bullet hell
  Q1339223: ["simulation"],                  // dating sim
  Q1036289: ["simulation", "strategy"],      // construction and management simulation
  Q18759108: ["racing"],                     // kart racing game
  Q30607131: [],                             // battle royale game (shooters and puzzle games alike)
  Q110505373: ["puzzle"],                    // nonogram video game
  Q1143118: ["adventure"],                   // interactive fiction
  Q7802107: ["puzzle"],                      // tile-matching video game
  Q33183362: ["adventure"],                  // walking simulator
  Q116790461: ["platformer"],                // 3D platform game
  Q116790414: ["platformer"],                // 2D platform game
  Q4375640: ["strategy"],                    // turn-based tactics
  Q14411698: [],                             // romance video game
  Q60480500: ["shooter"],                    // run and gun
  Q111184276: [],                            // dark fantasy video game
  Q604725: ["horror"],                       // psychological horror fiction
  Q63915027: ["sports"],                     // basketball video game
  Q113940337: ["horror"],                    // cosmic horror video game
  Q85797695: ["strategy"],                   // roguelike deck-building game
  Q96146237: ["shooter"],                    // vertically scrolling shooter
  Q1323555: [],                              // bishōjo game
  Q132886776: ["puzzle"],                    // Metroidbrainia
  Q113939522: [],                            // comedy video game
  Q3362070: [],                              // erotic video game
  Q113645065: ["action"],                    // character-action video game
  Q132858227: ["fighting"],                  // airdasher
  Q30347815: ["shooter"],                    // twin-stick shooter
  Q1635956: ["adventure"],                   // interactive film
  Q862490: [],                               // massively multiplayer online game
  Q105906396: ["rpg"],                       // turn-based role-playing game
  Q109603400: ["action", "platformer"],      // soulsvania
  Q110887639: ["action"],                    // crowd-combat video game
  Q2187138: ["music"],                       // dance video game
  Q1224999: [],                              // educational video game
  Q96146141: ["shooter"],                    // horizontally scrolling shooter
  Q16935625: ["sports"],                     // fishing video game
  Q125693245: ["action"],                    // action roguelike
  Q175173: ["rpg"],                          // massively multiplayer online role-playing game
  Q104819482: ["platformer"],                // collect-a-thon platformer
  Q10308060: ["puzzle"],                     // falling block puzzle game
  Q3739535: [],                              // art game
  Q56298645: ["sports"],                     // association football management game
  Q127602751: ["fighting"],                  // 2D fighting game
  Q1473699: [],                              // full motion video
  Q5383567: [],                              // episodic video game
  Q18351283: [],                             // incremental game
  Q21192427: [],                             // crossover fiction
  Q2127647: ["shooter"],                     // rail shooter
  Q54251760: [],                             // yuri game
  Q95124454: ["racing"],                     // arcade racing game
  Q96195505: ["platformer"],                 // cinematic platformer
  Q690342: [],                               // harem
  Q2070892: ["action"],                      // vehicular combat game
  Q121769643: ["platformer"],                // rolling platformer
  Q1201679: ["puzzle"],                      // escape room video game
  Q126598654: ["party"],                     // minigame collection
  Q108099476: ["puzzle"],                    // jigsaw puzzle video game
  Q124973056: [],                            // cozy game
  Q61791393: ["sports"],                     // miniature golf video game
  Q1260861: ["shooter"],                     // tactical shooter
  Q105702790: [],                            // Christmas video game
  Q21010853: [],                             // drama fiction
  Q2561438: [],                              // slice of life
  Q60617825: ["adventure"],                  // mystery video game
  Q116236809: ["music", "platformer"],       // rhythm platformer
  Q110639931: ["fighting"],                  // platform fighter
  Q63915162: ["sports"],                     // dodgeball video game
  Q62019045: ["sports"],                     // baseball video game
  Q105221690: ["sports"],                    // professional wrestling video game
  Q53911753: [],                             // isekai
  Q60256879: ["sports"],                     // golf video game
  Q13717398: ["puzzle"],                     // maze video game
  Q116680021: ["racing"],                    // driving video game
  Q61719571: ["adventure"],                  // detective video game
  Q71468194: ["sports"],                     // skateboarding video game
  Q123198231: [],                            // zombie apocalyptic video game
  Q61793886: ["sports"],                     // tennis video game
  Q7644030: [],                              // supernatural fiction
  Q130270654: ["fighting"],                  // arena fighter
  Q11282930: ["puzzle", "action"],           // action puzzle video game
  Q1189206: ["strategy"],                    // multiplayer online battle arena
  Q603555: ["strategy"],                     // 4X
  Q2313710: ["strategy"],                    // real-time tactics
  Q536420: ["simulation", "strategy"],       // god game
  Q11298493: ["party"],                      // quiz video game
  Q92608103: ["music"],                      // karaoke video game
  Q2016457: ["sports"],                      // fitness video game
  Q117474613: ["rpg"],                       // monster-taming game
  Q105475134: ["action", "rpg"],             // soulslike
  Q578868: ["simulation"],                   // vehicle simulation game
  Q467880: ["puzzle"],                       // programming game
  Q57775833: ["action"],                     // endless runner game
  Q25861761: ["simulation"],                 // virtual pet video game
  Q71726635: ["adventure"],                  // kinetic novel
  Q7049654: [],                              // nonviolent video game
  Q1194763: [],                              // 2D computer graphics
  Q9086092: [],                              // third-person view
  Q1299049: [],                              // first-person view
  Q2044250: [],                              // nonlinear gameplay
  Q254183: [],                               // augmented reality
  Q133287150: [],                            // retro-style video game
  Q170539: [],                               // parody
  Q113939436: [],                            // parody video game
  Q110738513: ["action"],                    // boss game
  Q7620492: ["adventure"],                   // storytelling game
  Q15079592: ["strategy"],                   // strategic game
  Q129722891: ["horror"],                    // science fiction horror
  Q129212292: ["puzzle"],                    // word video game
  Q229345: ["music"],                        // karaoke
  Q5434359: ["sports"],                      // fantasy sport
  Q133892278: [],                            // crime video game
  Q110746103: [],                            // coloring book game
  Q133884291: [],                            // neo-noir video game
  Q130728111: [],                            // existentialist video game
  Q320568: [],                               // yuri
  Q60616125: [],                             // political video game
  Q17049225: [],                             // vertically scrolling video game
  Q6158564: [],                              // Japanese detective fiction
  Q21570197: [],                             // typing software
  Q105702814: [],                            // halloween video game
  Q182015: [],                               // thriller
  Q2975633: [],                              // coming-of-age fiction
  Q122229711: [],                            // lesbian romance fiction
  Q123198217: [],                            // apocalyptic video game
  Q104860440: [],                            // digital tabletop game
  Q11084095: [],                             // historical video game
  Q60617897: [],                             // gambling video game
  Q137848202: [],                            // wholesome video game
  Q7168625: [],                              // historical drama
  Q16681627: [],                             // alternate history video game
};

export const MODE_TABLE = {
  Q208850: ["single"],                       // single-player video game
  Q6895044: ["multi"],                       // multiplayer video game
  Q1758804: ["coop", "multi"],               // co-op mode
  Q719798: ["multi"],                        // player versus player
  Q61005756: ["multi"],                      // shared/splitscreen multiplayer
  Q98559103: [],                             // bot multiplayer (computer opponents: says nothing about other people)
  Q107494132: ["coop", "multi"],             // local co-op
  Q1630770: ["multi"],                       // hotseat
  Q3297989: ["online", "multi"],             // multiplayer online game
  Q48510: ["multi"],                         // deathmatch
  Q5252671: ["multi"],                       // two-player video game
  Q1192658: [],                              // minigame
  Q1327648: [],                              // player versus environment
  Q116634: ["online"],                       // online game
  Q115770254: ["multi"],                     // asymmetrical multiplayer
  Q862490: ["online", "multi"],              // massively multiplayer online game
};

/** Item types that make an item a game for the library (through P279). */
export const GAME_TYPE_ROOTS = {
  Q7889: "video game",
  Q16070115: "video game compilation",
};
/** Types whose items are add-ons, never games of their own — checked before GAME_TYPE_ROOTS (they are subclasses of it). */
export const ADDON_TYPE_ROOTS = {
  Q1066707: "downloadable content",
  Q209163: "expansion add-on",
};
export const SERIES_TYPE_ROOTS = {
  Q7058673: "video game series",
};
export const ESPORTS_TYPE_ROOTS = {
  Q112144412: "esports discipline",
};
/** Types Wikidata does not (yet) place under "video game" although their items are games. */
export const GAME_TYPE_OVERRIDES = {
  Q7927917: "video game port",
  Q116774927: "Pokémon paired versions",
};
