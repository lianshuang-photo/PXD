<!-- Read ENGINEERING-STANDARDS.md before implementation/review. Use
docs/v2/templates/PR-ACCEPTANCE.md for the detailed record. State actual results;
unchecked boxes, fixtures or a filled-in template do not grant acceptance. -->

## Change and scope

Concrete user problem and resulting behavior:

- Affected application/host and controls, public state/error contracts:
- Prerequisite PR/comparison base (if stacked, this is not a merge target):
- Reused components/contracts and cross-module impact:

## Validation

Source commit and generated plugin/build correspondence:

| Verification | Passed / failed / unverified / not applicable + reason | Procedure, observed result and evidence |
|---|---|---|
| Automated checks and meaningful failure/recovery cases | | |
| Browser interaction | | |
| Photoshop backend execution | | |
| Actual PS panel visual/input interaction | | |

For UI changes, verify every affected target host. For Photoshop/UXP panels, identify tested control types, light/dark, 100%/200%, actual normal/narrow panel sizes, focus, keyboard/IME and selection/default-reset behavior; record PS/UXP versions. Browser-only changes need actual browser interaction and a reason for panel checks being not applicable. Both applications can include PS-facing UI; a React implementation is not inherently browser-only. Browser UI triggering PS operations is not native-panel acceptance.

## Independent review and open issues

- Reviewer, reviewed commit and findings/fix/recheck evidence:
- Remaining defects/unverified cases, impact and next validation step:
- Evidence report (use docs/v2/templates/PR-ACCEPTANCE.md):

Do not merge until independent approval, checks and applicable real-host acceptance are complete. New commits require renewed evidence; not-applicable explanations do not waive branch protection or release gates. An unavailable host leaves its validation unverified.
