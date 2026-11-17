# How to contribute

Thank you for wanting to help. You do not need to be a programmer to be useful: a clear bug report, a tested stage, or a screenshot is already a big help.

## Report a bug

Use the GitHub **bug report** issue template (see `.github/ISSUE_TEMPLATE/bug_report.md`). Include:

- what you were trying to do, and what happened instead
- the BeamNG.drive version, the BeamNG.Earth version, and your operating system
- a screenshot of the in-game console (`~`) if there are red errors
- the stage and roadbook files, or a share link from the stage builder, if you can share them

Please do not paste API tokens, passwords, or other private keys into an issue.

## Suggest an idea

Open an issue and describe the idea in plain language: who it helps, and how you would tell that it worked. Big features (for example online events) may already be planned and not yet public.

## Change the code

1. Fork the repository (once it is on GitHub) or copy the files.
2. Keep changes focused: one problem per pull request.
3. The website files live in `stage-builder/`. The in-game mod lives in `mod/`. Tests live in `tests/`.
4. If you change `stage-builder/roadbook-gen.js`, copy it to `mod/ui/modules/apps/RallyRaidPlanner/roadbook-gen.js` as well — the in-game planner must stay byte-identical to the website generator.
5. Do not commit secrets. Use environment variables and the `.env.example` file as a guide. Never put a Cloudflare, Discord, Resend or other API key in a file that will be committed.
6. Do not deploy the website or publish a mod zip unless wyans has said so in his own words.
7. The `events/` folder is unreleased work. Do not hook it up to the public site.

If you can, run the existing tests (`python3 tests/run_tests.py` for the Lua checks; see the files under `tests/` for the browser checks). If you cannot run them, say so in the pull request and describe how you tried the change.

## Language

Write comments and player-facing text in plain language. If you use a technical term, give a short definition the first time it appears, the same way the rest of the project does.
