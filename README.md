# Verðvakt

Vaktar verð á vörum í íslenskum vefverslunum (.is). Vaktin finnur sjálf þær verslanir sem selja vöruna, athugar verðið á 3 klst. fresti (á 30 mín. fresti í kringum afsláttardaga) og birtir samantekt á vefsíðu þegar verð lækkar.

**Vefsíðan:** https://brynjargunnarsson.github.io/verdvakt/

## Hvernig þetta virkar

```
GitHub Actions (á 30 mín fresti)
  └─ src/gate.js      ákveður hvort athugun sé tímabær (3 klst. / 30 mín. á afsláttartímabili)
  └─ src/run.js       1. les verð allra vaktaðra slóða           → data/prices.json, data/history/
                      2. á afsláttartímabili: tilboðssíður + kóðar → data/codes.json, data/candidates/
                      3. leitar að seljendum (nýjar vörur strax,   → data/candidates/<vara>.json
                         svo vikulega, daglega á afsláttartímabili)
                      4. samantekt yfir lækkanir + morgunyfirlit  → data/summaries.json
  └─ commit á data/

docs/  (GitHub Pages) les data/ og skrifar products.json, stores.json og sale-days.json í gegnum GitHub API.
```

### Verðlestur (`src/price.js`, `src/extract.js`)
1. Skipulögð gögn á síðunni (JSON-LD `Product`/`Offer`, `og:price`, microdata). Lægsta verð sem er til á lager er notað.
2. Ef þau vantar, eða á afsláttartímabili, er síðan opnuð í alvöru vafra (Playwright) og verðið lesið við fyrirsögn vörunnar. Yfirstrikuð verð teljast „fyrra verð“ og klúbbverð eru skráð sér.
3. Sýnilegt verð gildir ef það er lægra en skráða verðið (algengt þegar tilboð er bara sett í útlitið).

### Leit í verslunum (`src/search.js`)
Fyrir hverja verslun er prófað: Shopify-leit (JSON), WooCommerce-leit (JSON), svo að skrifa í leitarreit síðunnar eins og manneskja og lesa niðurstöðuspjöld, og loks algengar leitarslóðir. Það sem virkar er munað í `data/store-cache.json`.

### Afsláttardagar (`data/sale-days.json`)
- Athugað á 30 mín. fresti frá 12 klst. fyrir til 24 klst. eftir hvern dag.
- Tilboðssíður verslana („Black Friday“, „11.11“, „Tilboð“ …) eru skoðaðar og vörur sem passa við vöktuðu vörurnar birtast sem tillögur.
- Afsláttarkóðar eru lesnir af forsíðum („Notaðu kóðann BF20 …“) og áætlað verð með kóða sýnt.
- **Gerviafsláttur:** merkt ef verð var hækkað innan 45 daga fyrir afsláttartímabilið og „tilboðið“ er ekki lægra en verðið var áður, eða ef „fyrra verð“ verslunar er hærra en nokkurt verð sem vaktin sá síðustu 30 daga.

### Gjafabréf og veitingar
Hópkaup (veitingatilboð, öll tilboð, jólagjafir), Dineout, Óskaskrín, Gjafabref.is, Noona og Aha eru á verslanalistanum. Hjá síðum þar sem leitin virkar ekki eru fastir tilboðslistar (`listUrls` í `data/stores.json`) lesnir í hverri leit. Gjafabréf með föstu nafnverði (t.d. 10.000 kr. kort) breytast sjaldan í verði; vaktin nýtist best á tilboð eins og „kvöldverður fyrir tvo“ eða þegar gjafabréf eru seld með afslætti.

## Góði hirðirinn (`src/hirdir/`)
Sérstakt tól sem vaktar nýjar vörur á godihirdirinn.is og á að flagga þær sem eru verðlagðar langt undir markaðsvirði. Skref 1 og 2 eru til:

```bash
npm install
npm run hirdir:scan                  # 1. skannar og vistar nýjar, óseldar vörur í data/hirdir/hirdir.db
export ANTHROPIC_API_KEY=...         #    lykill frá console.anthropic.com
npm run hirdir:analyze               # 2. Claude greinir óunnar vörur (mest 50 í keyrslu)
npm run hirdir:analyze -- --dry-run  #    sýnir hvað yrði greint, án þess að kalla á Claude
npm test
```

**Skönnun (`scan.js`)**
- Forsíðan sendir allan vörulistann (líka það sem „Hlaða inn eldri vörum“ birtir) í síðugögnunum, svo hver keyrsla er tvær fyrirspurnir: `robots.txt` og forsíðan. Ef listinn finnst ekki þar eru sýnilegu vöruspjöldin lesin og lýsingin sótt af vörusíðum (mest 40 í keyrslu).
- `robots.txt` er lesið í hverri keyrslu og virt (`/api/` og `/admin` eru bönnuð); a.m.k. 2,5 sek. eru milli fyrirspurna.
- Vörur merktar SELT eru ekki vistaðar. Vara sem selst eða hverfur síðar er merkt `sold`/`gone`.
- Í fyrstu keyrslu á tóman grunn fer allt sem þegar er á síðunni í bakskrá (`analysis_status = 'backlog'`) og er aldrei greint; aðeins vörur sem bætast við eftir það eru unnar. `--analyze-all` sleppir bakskránni.

**Greining (`analyze.js`)**
- Sendir Claude aðalmynd vörunnar (slóð á 1024 px útgáfu), titil, flokk, verð, ástand og lýsingu og fær til baka framleiðanda, gerð, enskan eBay-leitarstreng, fjölda eininga og öryggisstig (`high`/`medium`/`low`).
- Almennar, ómerktar eða séríslenskar vörur fá `analysis_status = 'no_comparison'` með ástæðu; hinar `ok`.
- Líkan: `claude-opus-5-5` (breytist með `HIRDIR_MODEL`). Ef líkanið hafnar beiðni reynir API-ið sjálft annað líkan (`fallbacks`).
- Villa á einni vöru stöðvar ekki keyrsluna; varan er reynd aftur í næstu keyrslum, mest þrisvar. Lækki verð á greindri vöru fer hún aftur í vinnslu.
- `--handle <slóðarheiti>` greinir eina tiltekna vöru, líka úr bakskrá – hentugt til að prófa.

Grunnurinn er ekki í git (`.gitignore`).

## Keyra á eigin tölvu

```bash
npm install
npx playwright install chromium
FORCE=true node src/run.js          # athuga öll verð
node src/discover.js <vöru-id>      # leita að seljendum
python3 -m http.server 8000         # og opna http://localhost:8000/docs/
```

## Takmarkanir
- Sumar verslanir loka á sjálfvirkar heimsóknir frá gagnaverum (t.d. ht.is svarar 403). Þær birtast með villu undir *Verslanir*.
- Verð sem krefjast innskráningar sjást ekki. Klúbbverð eru aðeins lesin ef þau sjást án innskráningar.
- Sendingarkostnaður er ekki tekinn með.
- Afsláttarkóðar eru lesnir úr texta og geta verið rangir eða bundnir skilyrðum.
- GitHub keyrir tímasettar keyrslur stundum nokkrum mínútum of seint.
