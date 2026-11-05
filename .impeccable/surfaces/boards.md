# Boards

Mode: Operate. Target: desktop/renderer/BoardsView.tsx.

The owner follows filtered public company career pages. This surface saves those links, checks for unseen job identities with the selected AI provider, and retains a count until the owner marks it reviewed. It does not display individual vacancies or transfer them to Plan. Its SQLite file is independent of Applications and can live in OneDrive.

## Direction contract

THESIS: A compact watch list makes the next check and outstanding review obvious in each company row.

OWN-WORLD: Inherit Zebby's Ember colors, system type, rust actions, native titlebar, aligned settings rows, and light/dark appearances. Reuse the existing controls and left navigation.

STORY: Paste board links, establish a baseline, check again, review the original website, then acknowledge the discoveries.

FIRST VIEWPORT: Boards heading and Private tag at left, Check all and Add boards at right. Rows align company/link, last checked date, discovery notice, and actions. The empty state offers database setup or adding the first links.

FORM: The user's specified list, extended within the existing visual system. No concept seed is needed for this settled composition. Narrow layouts wrap each row without horizontal page scrolling.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Observed implementation

Documented November 4, 2026 as an ordinary extension of Ember. The existing `DESIGN.md` and `.impeccable/design.json` remain the shared visual authority. This surface introduces no replacement palette, font family, elevation system, or shipping raster.

- Navigation places Boards between Applications and Settings. The label carries a small outlined Private tag, and the page repeats that status beside its heading. The shared navigation component retains selected-page semantics, icon fallback, activation animation, reduced-motion handling, and the zebra toggle.
- The toolbar pairs the heading with Check all and Add boards. A quiet provider/model line links to Analysis settings. Four aligned groups present company and source link, last checked date, the new-listing count or check state, and actions. The list shows counts only; the source link opens the original board.
- Rows and the editor remain flat with fine separators. Colors use the existing canvas, ink, ink-soft, line, line-strong, accent, accent-wash, field, and surface-hover tokens. Typography inherits the platform stack. The page heading is 25px at weight 650, company names are 15px at weight 650, supporting row content is 12px, and column labels are 11px. Primary and secondary actions reuse the shared buttons.
- The wide list uses four columns with an 18px gap. At 1180px or less, the header disappears and each row becomes two columns with an inline date label. At 850px or less, all row groups stack and actions align left. The existing workspace supplies vertical scrolling at the 790px minimum desktop width.
- Add boards accepts one link per line with an optional company name and a freeform Tracking instructions field. A bulk add applies the same instructions to each link. The saved row shows the instructions and the matching role count from the last successful check. Editing the link or instructions explains when the new baseline starts. The existing draft protections cover all three fields.
- No-file setup offers Open Boards database and Create Boards database. The file footer reveals the same controls, and Settings includes a Boards database section after the Applications database section. Pending file saves expose Retry save and Save recovery copy, with affected mutations and database switching disabled. Check progress stays within its company row, with Cancel check disabled during saving; errors remain beside the affected work.

## Handoff evidence

The finish reviewer returned **ship** after the verdict pass accepted the draft-replacement guard and placeholder contrast fixes. This documentation pass checked the current source and the saved captures below against the direction contract and Ember's shared tokens, flat surfaces, native type, and controls.

| Evidence | Observed result |
| --- | --- |
| `.impeccable/review/boards-desktop-light.png` and `boards-desktop-dark.png` | 1550 by 850 desktop layouts preserve the four-group row alignment, count emphasis, source links, and per-row actions in both appearances. |
| `.impeccable/review/boards-compact-light.png` and `boards-compact-dark.png` | 790 by 620 layouts stack each row while keeping the date, count, review action, and check controls readable. |
| `.impeccable/review/boards-setup.png` | Database setup uses the existing location block and settings actions. |
| `.impeccable/review/boards-add.png` | The inline editor retains visible focus, readable placeholders, baseline guidance, and clear primary and Cancel actions. |
| `.impeccable/review/boards-checking.png` | Row progress and Cancel check preserve the surrounding list. |
| `.impeccable/review/boards-recovery.png` | Pending-save recovery exposes both recovery actions and the disabled affected controls. |

Implementation references: `desktop/renderer/BoardsView.tsx`, the Boards rules at the start of `desktop/renderer/desktop.css`, and the navigation/settings integration in `desktop/renderer/App.tsx` and `desktop/renderer/NavigationButton.tsx`. Shared token and behavior references remain `desktop/renderer/base.css` and the existing desktop shell rules. The capture sequence lives in `scripts/qa-boards-renderer.mjs`; it includes assertions for horizontal overflow, draft preservation, failed-add retention, review acknowledgement, progress controls, and retry recovery. The retained zebra raster is `public/brand-icon.png`.

## Existing documentation drift

- The context resolver lists the existing surface briefs with null primary and related targets, including this brief's prose Target. The supplied source path and this file were matched directly for this handoff.
- `DESIGN.md` and the sidecar still describe their extraction as version 1.6.0; the sidecar generation date remains October 2, 2026. Later approved design notes already appear in `DESIGN.md`.
- The beta uses the Zebby - Beta title and adds Boards between Applications and Settings.

These existing discrepancies were reported and left unchanged. The observed Boards implementation is consistent with Ember, and this handoff updates only this surface brief.
