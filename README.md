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

### Verðsaga og línurit
Hver verðbreyting er skráð í `data/history/<vara>.json` (tími og verð fyrir hverja slóð) frá fyrstu athugun. Á síðunni sýnir línuritið verð hverrar verslunar frá því vöktun hófst til dagsins í dag. Verð helst óbreytt þar til það breytist, svo línan er skreflína. Breið ljós lína sýnir besta verð (ekki markaðstorg og ekki uppselt), músarvísir sýnir öll gildi á völdum tíma og smellt er á lykil til að fela eða sýna línu. Hjá vörum með fleiri en 4 verslanir byrjar línuritið á besta verði einu. Taflan undir línuritinu lýsir öllum verðbreytingum. Línuritið er í `docs/chart.js` án utanaðkomandi bókasafna.

### Gjafabréf og veitingar
Hópkaup (veitingatilboð, öll tilboð, jólagjafir), Dineout, Óskaskrín, Gjafabref.is, Noona og Aha eru á verslanalistanum. Hjá síðum þar sem leitin virkar ekki eru fastir tilboðslistar (`listUrls` í `data/stores.json`) lesnir í hverri leit. Gjafabréf með föstu nafnverði (t.d. 10.000 kr. kort) breytast sjaldan í verði; vaktin nýtist best á tilboð eins og „kvöldverður fyrir tvo“ eða þegar gjafabréf eru seld með afslætti.

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
