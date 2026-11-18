# Holló eseménytér – telepítési útmutató

A felület Netlify-on fut, és minden eseményt meg feltöltött fájlt automatikusan a te személyes OneDrive-odba ment, a **Holló Archívum** mappába. A szervezők egy közös jelszóval lépnek be. A koordinátorok egy külön jelszóval lépnek be, és csak ők tudnak elfogadni, visszaállítani és eseményt törölni.

Kb. 30 perc az egész, és csak egyszer kell megcsinálni.

> Fontos: a Netlify „drag & drop” (Netlify Drop) feltöltése **nem** működik ehhez, mert az nem futtatja a szerveroldali részt. Ezért megy GitHubon keresztül. Ez is csak böngészős húzogatás.

---

## 1. Feltöltés GitHubra

1. Regisztrálj vagy lépj be: https://github.com
2. Jobb fent **+ → New repository**.
   - Repository name: `hollo-esemenyter`
   - Válaszd a **Private** lehetőséget
   - **Create repository**
3. Az üres oldalon kattints az **uploading an existing file** linkre.
4. Csomagold ki a ZIP-et, és a `hollo-netlify` mappa **tartalmát** húzd be a böngészőbe (Chrome vagy Edge). Ezek a fájlok és mappák:
   - `netlify.toml`
   - `package.json`
   - `OLVASS_EL.md`
   - `public` mappa
   - `netlify` mappa
5. Lent kattints a **Commit changes** gombra.
6. Ellenőrizd, hogy a GitHubon látszik a `netlify/functions/api.mjs` fájl.

## 2. Netlify oldal létrehozása

1. https://app.netlify.com → **Add new project → Import an existing project → GitHub**.
2. Engedélyezd a GitHub-hozzáférést, majd válaszd ki a `hollo-esemenyter` tárolót.
3. A beállításokon ne változtass (a `netlify.toml` mindent megad), kattints a **Deploy** gombra.
4. **Project configuration → General → Change project name**: például `hollo-esemenyek`.
   Így a cím: `https://hollo-esemenyek.netlify.app`. **Jegyezd fel**, kell a 3. lépésben.

## 3. Microsoft-alkalmazás regisztrálása

Ezzel engedélyezed, hogy a Holló oldal írhasson a OneDrive-odba. A jelszavadat senki nem kapja meg.

1. Nyisd meg: https://entra.microsoft.com, és lépj be **azzal a személyes Microsoft-fiókkal, amelyiknek a OneDrive-ját használni akarod**.
2. Bal oldalt: **Applications (Alkalmazások) → App registrations (Alkalmazásregisztrációk) → New registration (Új regisztráció)**.
   - Name: `Holló eseménytér`
   - Supported account types: **Personal Microsoft accounts only** (Csak személyes Microsoft-fiókok)
   - Redirect URI: válaszd a **Web** típust, és írd be:
     `https://hollo-esemenyek.netlify.app/api/ms-callback`
     (a saját Netlify-címeddel, a végén `/api/ms-callback`)
   - **Register**
3. Az áttekintő oldalon másold ki az **Application (client) ID** értékét. Ez lesz az `MS_CLIENT_ID`.
4. **Certificates & secrets → Client secrets → New client secret**.
   - Expires: **24 months**
   - **Add**, majd **azonnal** másold ki a **Value** oszlop értékét (nem a Secret ID-t). Ez lesz az `MS_CLIENT_SECRET`. Később nem lehet újra megnézni.
5. **API permissions → Add a permission → Microsoft Graph → Delegated permissions**.
   - Pipáld be: `Files.ReadWrite` és `offline_access` (a `User.Read` már ott van)
   - **Add permissions**

> Ha az Entra nem enged be személyes fiókkal, vagy azt írja, hogy nincs címtárad, próbáld a https://portal.azure.com oldalt, ott is **App registrations** a menüpont. Ha Azure-előfizetést kér, az ingyenes, de kártyás ellenőrzést kérhet. Ha elakadsz, írd meg, mit látsz.

## 4. Beállítások a Netlify-on

**Project configuration → Environment variables → Add a variable**. Négy változót adj hozzá:

| Kulcs (Key) | Érték (Value) |
|---|---|
| `MS_CLIENT_ID` | a 3. lépés Application (client) ID-ja |
| `MS_CLIENT_SECRET` | a 3. lépés titkos Value-ja |
| `HOLLO_JELSZO` | a szervezők közös jelszava (te találod ki) |
| `HOLLO_KOORDINATOR_JELSZO` | a koordinátorok jelszava (legyen más!) |

Nem kötelező: a `HOLLO_MAPPA` változóval más mappanevet adhatsz meg (alapból: `Holló Archívum`).

Utána: **Deploys → Trigger deploy → Deploy project**. Várj, amíg „Published” lesz.

## 5. A OneDrive összekapcsolása

1. Nyisd meg az oldalt (`https://hollo-esemenyek.netlify.app`).
2. Lépj be a neveddel és a **koordinátor** jelszóval.
3. Kattints a **Bejelentkezés Microsofttal** gombra, lépj be ugyanazzal a fiókkal, mint a 3. lépésben, és fogadd el az engedélykérést.
4. A „Kész, a OneDrive össze van kötve” oldal után a OneDrive-odban megjelenik a **Holló Archívum** mappa.

## 6. Megosztás

Küldd el a szervezőknek az oldal címét és a **szervezői** jelszót. Mindenki a saját nevét írja be belépéskor, így látszik az előzményekben, ki mit csinált.

---

## Ki mit tud csinálni

| | Szervező | Koordinátor |
|---|---|---|
| Esemény felvétele, szerkesztése | ✓ | ✓ |
| One-pager és kommunikációs terv feltöltése, új verzió | ✓ | ✓ |
| Még el nem fogadott fájl törlése | ✓ | ✓ |
| Elfogadás, visszaküldés javításra | | ✓ |
| Állapot visszaállítása, elfogadott fájl törlése | | ✓ |
| Esemény törlése, OneDrive leválasztása | | ✓ |

## A OneDrive mappa szerkezete

```
Holló Archívum/
├─ osszes_esemeny.csv            ← minden esemény egy táblázatban (Excelben megnyitható)
├─ Budapest/
│  ├─ Budapest_esemenyek.csv
│  └─ 2026/
│     └─ 2026-11-26_Filmklub/
│        ├─ esemeny.txt          ← adatok + teljes előzmény
│        ├─ OnePager - ….pdf
│        ├─ Kommunikacios_terv - ….docx
│        └─ korabbi_verziok/
├─ Szeged/ …
└─ _adatok/                       ← a felület adatai: NE töröld, NE szerkeszd
```

A törölt fájlok és események a OneDrive **lomtárába** kerülnek, onnan 30 napig visszaállíthatók.

## Karbantartás

- **A titkos kulcs 24 hónap után lejár.** Tegyél be egy emlékeztetőt a naptáradba. Lejárat előtt: 3.4. lépés újra, az új értéket írd be az `MS_CLIENT_SECRET` helyére, majd *Trigger deploy*.
- **Jelszócsere:** írd át a változót a Netlify-on, majd *Trigger deploy*. Ilyenkor mindenki kilép, és az új jelszóval kell belépni.
- **Ha sokáig senki nem használja az oldalt** (kb. 90 nap), a Microsoft-kapcsolat lejárhat. Ilyenkor a koordinátor belépéskor újra látja a „Bejelentkezés Microsofttal” gombot. Egy kattintás, és az adatok megmaradnak.
- **Másik OneDrive-fiókra váltás:** Archívum → *OneDrive leválasztása*, majd összekapcsolás az új fiókkal. A régi fiókban lévő adatok ott maradnak, át kell őket másolni.
- **Javítás vagy új funkció:** a GitHubon cseréld le a módosított fájlt (*Add file → Upload files*), a Netlify magától frissül.
