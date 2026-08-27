# Orientation design system

## Direction

The team orientation uses an accessible mission-control handbook style. It is a
desktop-first, print-friendly long-form document. The layout combines strong
wayfinding, evidence-led content, and restrained status color.

## Color roles

| Role            | Value     | Use                                           |
| --------------- | --------- | --------------------------------------------- |
| Deep ink        | `#101827` | Dark sections and primary text                |
| Ink surface     | `#172033` | Raised dark surfaces                          |
| Warm paper      | `#f7f5ef` | Main reading surface                          |
| White           | `#ffffff` | Evidence cards and high-contrast text         |
| Cobalt          | `#2457e6` | Navigation, links, focus, and section markers |
| Cobalt light    | `#5b7cfa` | Supporting accents                            |
| Verified green  | `#177a4a` | Verified evidence only                        |
| Regression red  | `#c9363e` | Barriers and regressions only                 |
| Coverage amber  | `#a95f00` | Not-covered state only                        |
| Approval violet | `#7452b8` | Human approval only                           |
| Slate           | `#596579` | Secondary text and rules                      |

Status colors always appear with a text label and a distinct symbol or border.

## Typography

- Headings: `Inter`, `Segoe UI`, `Helvetica Neue`, Arial, sans-serif.
- Body: `Inter`, `Segoe UI`, `Helvetica Neue`, Arial, sans-serif.
- Commands and evidence: `SFMono-Regular`, Consolas, `Liberation Mono`, monospace.
- Body copy is at least 17 pixels on screen with a line height near 1.6.
- The hero uses a compact display scale so the first screen still shows evidence.

## Layout

- Maximum content width: 1240 pixels.
- Twelve-column editorial grid for large sections.
- Section numbers form a persistent left rail.
- One-pixel rules separate related evidence without turning every item into a card.
- Dark sections mark product truth and closing claim boundaries.
- Print removes sticky behavior and preserves status labels in text.

## Components

- Utility header with four-step orientation route.
- Evidence receipt with source, coverage, and verification facts.
- Idle note followed by the four-verdict strip.
- Provider-to-result-to-surface system map.
- Six-step broken-to-verified proof loop.
- Three-repository responsibility map.
- Contribution lanes with a start action and first useful contribution.
- First-hour checklist and three-week finish plan.
- Claim boundary with supported claims and explicit limits.

## Interaction

- Native links and details elements provide all interaction.
- Focus uses a visible cobalt outline with a paper offset.
- Motion is not required to understand or use the document.
- The page does not depend on JavaScript.
