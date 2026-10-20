# BeyondView clone: Medical & Life Sciences

A static marketing site for a 3D commercial real estate visualization product. It follows the
layout and visual style of [beyondview.com](https://beyondview.com/), with the focus on its
[Medical & Life Sciences](https://beyondview.com/verticals/medical/) vertical.

The structure, section order and look (dark slate header, Quicksand and Roboto type, pill
buttons, gradient bands) follow the reference site. The copy, imagery and logo are all new:

- **Brand**: shipped under a placeholder name, **Previsio**, with an original logo mark.
- **Copy**: written fresh for this project. None of the reference site's text is reused.
- **Imagery**: every picture is rendered from a procedural Three.js lab scene in this repo
  (`assets/js/lab-scene.js`), so there are no licensing questions.
- **Interactive tour**: the reference page embeds a hosted 360° tour. Here it is a real-time 3D
  walkthrough of a lab suite that you can switch between *As-is shell*, *Whitebox* and
  *Lab fit-out*.

## Pages

| Path | What it is |
| --- | --- |
| `verticals/medical/` | **Main page.** Hero, overview, feature cards, trust band, before/after slider, property types, interactive 3D tour, process, FAQ and lead form |
| `verticals/medical/tour.html` | Full-window version of the tour (the "Open In New Tab" target). Accepts `?mode=raw\|whitebox\|lab&view=entry\|aisle\|hoods\|writeup\|corner` |
| `/` (`index.html`) | Home page in the reference site's section order: hero, testimonials, whitebox/reposition sliders, gallery carousel, healthcare callout, process, product features, AR, portfolio dashboard, lead form |
| `404.html` | Not-found page |

## Running locally

The tour uses ES modules, so serve the folder over HTTP rather than opening files directly:

```bash
npm start            # zero-dependency static server on http://localhost:8080
# or: python3 -m http.server 8080
```

Then open <http://localhost:8080/verticals/medical/>.

There is no build step. Three.js r160 is vendored in `assets/vendor/three/` (MIT licensed), so the
site has no runtime CDN dependencies apart from Google Fonts.

## Project layout

```
assets/
  css/styles.css        Design tokens and all component styles
  js/main.js            Nav, dropdowns, sliders, carousel, scroll reveal, form handling
  js/tour.js            Mounts the interactive tour into [data-tour] elements (lazy-loaded)
  js/lab-scene.js       Procedural lab scene: modes, camera viewpoints, materials
  img/renders/          JPEGs rendered from lab-scene.js
  vendor/three/         Three.js + OrbitControls + RoomEnvironment
scripts/
  serve.mjs             Local static server
  render.mjs            Re-renders assets/img/renders/ with headless Chromium
  render.html           Harness page used by render.mjs
  check-links.mjs       Verifies every local link, asset and #anchor resolves
```

## Regenerating the renders

Change the scene in `assets/js/lab-scene.js` (or the shot list in `scripts/render.mjs`), then:

```bash
npm install          # installs Playwright (dev only)
npm run render       # all shots
npm run render hero  # only shots whose name contains "hero"
```

If Playwright cannot find a browser, set `CHROMIUM_PATH` to a local Chromium or run
`npx playwright install chromium`.

## Checks

```bash
npm run check        # every local href/src/url() and #anchor resolves
```

## Placeholders to replace before going live

- **Brand name and logo**: "Previsio" and `assets/img/logo-mark.svg`.
- **Client logos**: the trust bands use generic category marks ("Healthcare REIT", and so on).
  Swap in real client logos only with permission.
- **Testimonials**: the three quotes on the home page are marked *Sample*. Replace them with real,
  approved quotes.
- **Lead form**: validates and shows a confirmation, but sends nothing yet. Add an `action`
  (your CRM or a form service) to the `<form>` and `main.js` will let it submit normally.
- **Stub links**: Office & Retail, Multi-family, New Construction, Solutions, Pricing, Careers,
  Press and Terms point at sections of the existing pages until those pages exist.
- **Contact email**: `press@example.com`.
- `404.html` uses root-relative paths, so it assumes the site is served from a domain root.
