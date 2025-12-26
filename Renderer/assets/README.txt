# 📘 Atlas Renderer – Assets Struktur

## 📂 1. Översikt

Renderer använder följande struktur för alla statiska filer:

```
assets/
│
├── css/              → Globala CSS-regler (layout, loader etc)
├── icons/            → Ikoner för UI, knappar etc
├── images/           → Övriga bilder som inte hör till teman
│   └── backgrounds/  → Bibliotek med sparade / extra bakgrunder
└── themes/           → Varje tema i egen mapp
```

---

## 🎨 2. Tema-struktur

Varje tema ligger i en egen mapp under:

```
assets/themes/<tema-namn>/
```

### Namnregler (måste följas)
- Endast **gemener**
- Endast **bindestreck**
- Exempel:  
  - `chrome-light`  
  - `apple-dark`  
  - `apple-road`

### Varje tema har **exakt två filer**:

```
theme-name/
│
├── theme-name.css
└── theme-name-bg.jpg
```

Regler:
- CSS-filen **måste ha samma namn** som tema-mappen.
- Bakgrundsbilden **måste heta** `<tema>-bg.jpg`.
- Inga extra filer i tema-mappen.

---

## 🖼 3. Images/backgrounds – bibliotek

`assets/images/backgrounds/` innehåller bilder som **inte används automatiskt**.

Syfte:
- ditt arkiv av snygga bakgrunder
- testbilder
- gamla versioner
- inspirationsbilder

För att använda en bild i ett tema:
1. Kopiera bilden hit
2. Döp om till `<tema-namn>-bg.jpg`
3. Flytta in i rätt tema-mapp
4. Starta om appen

---

## 🧩 4. Övriga mappar

### `assets/css/`
Globala CSS för appen:
- `style.css`
- `loader.css`
- övrigt UI som inte är tema-specifikt

### `assets/icons/`
Innehåller:
- ikoner till menyer
- appens ikon-filer (tray, toolbar, app)

Rekommenderade undermappar:
- `icons/app/`
- `icons/tray/`
- `icons/toolbar/`

### `assets/images/`
Övriga bilder som används i appen, t.ex logotyper.

---

## 🧭 5. Regler för framtiden

- Alla teman använder namnschemat:  
  `<tema>/<tema>.css`  
  `<tema>/<tema>-bg.jpg`
- Temamappen får endast innehålla dessa 2 filer
- Nya bakgrunder testas i `/images/backgrounds/`
- Globala filer hör hemma i `css/`, `icons/`, `images/`

---

## 🧱 6. Framtida funktioner
Denna struktur stödjer kommande funktioner:
- live theme editor
- theme manager UI
- auto dark/light switching
- remote theme fetching
