<img src="public/brand-icon.png" width="88" alt="Zebby, a zebra wearing sunglasses" />

# Zebby - Beta

Plan roles, track applications, and check your saved job boards for new listings.

This public beta extends [Zebby](https://github.com/desigrit/zebby-the-scout) with a personal **Boards · Private** tab. It installs as **Zebby - Beta**, with its own settings, credentials, model downloads, and application identity.

## Boards

1. Open **Boards** and create a **Zebby Boards.sqlite** file, or open an existing one. Choose your OneDrive folder to share history across computers.
2. Paste company career-page links, one per line. In **Tracking instructions**, describe which openings to count. For example, “Look under the Product heading for product manager roles” or “Only track Senior or Principal Product Manager roles.” Leave it blank to track all openings.
3. **Add and check** saves the first complete scan as a baseline. Existing listings start with a count of zero new listings.
4. Use **Check for updates** or **Check all**. New listing counts accumulate until you choose **Mark as reviewed**.
5. Open the saved website link to review the roles.

Boards reads the full results list and uses the model selected in Settings to apply your instructions to each newly seen vacancy. It uses the title, section heading, and text visible in the listing row. Boards remembers each decision and counts new matches by job ID. Editing the link or instructions starts a fresh baseline on the next check.

The reader supports Figma's grouped openings, pagination and coverage checks for Slack, Uber, and Meta, and AI navigation for other public boards. Failed or incomplete checks keep the last successful date and count. Open the source link to review the roles.

## Your databases

Applications and Boards use separate SQLite files. The Applications schema stays compatible with public Zebby. Open your existing Applications file in Settings to use it with the beta.

Boards works on a local copy and publishes complete changes to your selected file. If a save fails, use **Retry save** or **Save recovery copy**. Quit the app and let OneDrive finish syncing before opening the same files on another computer.

The beta stores API keys, wallet credentials, model downloads, and local caches in its own profile. Install updates manually from the beta repository.

## AI methods

- **OpenAI or Anthropic:** use your API key in Settings.
- **Ollama:** use your running server and selected model.
- **Downloaded models:** install a model in Settings.
- **Zebby credits:** Boards requires the server's `board_extract` migration and an enabled owner wallet. [Service setup](docs/boards.md#credits-service-rollout) describes the deployment.

## Run locally

Use Node.js 22.13 or newer.

```sh
npm ci
npm run dev
```

```sh
npm test
npx tsc --noEmit
npm run lint -- --quiet
npm run build
npm run test:renderer
```

Build a Windows x64 installer with `npm run desktop:package:win:x64`. The first package build downloads the bundled local inference runtime. The **Zebby Beta checks** workflow runs tests on pushes and can build an installer when started manually.

[Boards architecture and checks](docs/boards.md) · [Public Zebby](https://github.com/desigrit/zebby-the-scout) · [Report a beta issue](https://github.com/desigrit/zebby-the-scout-beta/issues)
