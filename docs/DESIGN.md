# Sky Holding website design

The current design follows [Sinar Mas](https://www.sinarmas.com/), selected by the user on 27 September 2026. This replaces the earlier Kawan Lama direction. The reference was inspected through live desktop/mobile rendering and its public [stylesheet](https://www.sinarmas.com/css/style.css).

## Direction and adaptation

The reference uses a compact white fixed header, panoramic image banners, Helvetica-style sans-serif typography, centered uppercase section headings, alternating white/pale-gray sections, rectangular content grids and a vivid red footer. Sky Holding adapts these patterns into a shorter, simpler presentation:

- A white sticky header with the original Sky Holding typographic/geometric mark, now using the red accent, and compact desktop/mobile navigation.
- One full-width landscape hero with the API homepage title and description, a readable dark overlay and a working red introduction link.
- A centered heading and the existing API Markdown body in a pale-gray introduction band.
- A rectangular grid linking only to other published CMS pages, omitted when no additional pages exist.
- A compact red footer, matching article/error/not-found treatments, clear focus indicators and reduced-motion support.

The local font stack is Helvetica Neue/Helvetica/Arial/sans-serif, without a remote font dependency. Main colors are charcoal `#303436`, white `#ffffff`, pale gray `#f7f7f6`, muted text `#666b6e` and red `#c7192c`. The darker red adapts the reference's bright red while keeping small white button/footer text readable. The reference's dense feeds, carousel and lengthy footer are simplified to the existing content and working destinations.

## Content and assets

Homepage copy, page bodies and published destination records continue to come from the API. The redesign does not invent business units, subsidiaries, statistics, addresses, contacts or news. Current homepage copy remains the minimal seed content. Final corporate content and brand approval remain in the launch plan. The dashboard and API schema are unchanged.

The new `web/public/images/sky-landscape.png` is an original 1672 × 941 decorative image generated with the built-in image generation tool. The final prompt describes an imaginary photoreal editorial aerial view of tropical forested hills, a broad winding river, misty mountains and warm sunrise, with a shadowed left side for white headings; it excludes actual company property, recognizable locations, buildings, people, flags, text and logos. No reference image was supplied. The result was inspected after copying it into the workspace.

The image is an illustrative landscape, not a photograph of Sky Holding property. It uses empty alternative text within an assistive-technology-hidden decorative layer. Next.js imports it as a hashed build asset and serves responsive optimized variants. Replacing this bundled hero currently requires a code change/redeployment; uploaded Markdown imagery remains API/CMS-managed. An independent CMS hero selector is a separate API/editor feature. The previous silver/glass artwork is no longer used by the page.

The wordmark, red palette and landscape remain proposed brand treatments. No Sinar Mas logo, photographs, prose, corporate facts or contact information were copied. Safe Markdown, SSR, canonical metadata, structured data and draft exclusion are preserved, as are strict TypeScript and the existing CI/CD rules.

## Validation

Run root lint/type checking, the public-site production build, the smoke suite and all Playwright tests against rebuilt containers. Design coverage includes 1440, 1024, 768, 375 and 320 px, responsive image loading, JavaScript-disabled content/navigation, no horizontal overflow, keyboard Escape/focus restoration, published-page cards, long titles and draft exclusion. Temporary fixture pages are removed after browser tests.

Screenshots are emitted by `tests/e2e/design.spec.ts` into Playwright test output for visual review. Final content, supported-browser, hosted accessibility/performance and brand acceptance remain launch tasks; local browser checks use Chromium.

The Sinar Mas adaptation passed root lint/type checking, native and container production builds, HTTP smoke checks and all nine browser/contract tests on 27 September 2026. Desktop/mobile screenshots were reviewed, including published-page fixtures. The test pass also verifies the corrected long-title breadcrumb overflow and stable sticky-header height. Temporary published/draft fixture records were removed; only the existing homepage remains published locally.
