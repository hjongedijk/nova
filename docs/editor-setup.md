# Editor setup

Open the repository root in VS Code and run `npm install` using Node 24 or newer.
Open Extensions and search `@recommended` to install the workspace recommendations.

## VS Code

| Extension                                                                                              | Why it fits NOVA                                                                      |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| [Svelte](https://marketplace.visualstudio.com/items?itemName=svelte.svelte-vscode)                     | SvelteKit component completion, diagnostics, and formatting.                          |
| [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint)                   | Uses the root flat ESLint config for TypeScript, JavaScript, and Svelte.              |
| [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)                 | Uses the existing Prettier config and Svelte plugin.                                  |
| [EditorConfig](https://marketplace.visualstudio.com/items?itemName=EditorConfig.EditorConfig)          | Applies the existing indentation and PowerShell line-ending rules.                    |
| [PowerShell](https://marketplace.visualstudio.com/items?itemName=ms-vscode.PowerShell)                 | Editing and debugging the Windows agent scripts; requires PowerShell on your machine. |
| [Container Tools](https://marketplace.visualstudio.com/items?itemName=ms-azuretools.vscode-containers) | Dockerfile and Compose workflows; running containers requires Docker.                 |
| [YAML](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)                         | Compose and GitHub Actions YAML editing.                                              |
| [Claude Code](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code)               | Claude inside VS Code.                                                                |

The workspace settings format files on save and apply ESLint fixes on explicit saves.
Svelte uses its own extension as formatter; other supported files use Prettier,
and PowerShell uses its own formatter. Generated output and local runtime data are
excluded from searches and file watching. TypeScript uses the installed workspace
version; accept VS Code's workspace TypeScript prompt when shown.

Use **Terminal → Run Task** for dev, build, tests, lint, type checking, and formatting
checks. **Ctrl+Shift+B** runs the build task. The dev task runs until you stop it with
**Terminal → Terminate Task**. Tasks reuse the root npm scripts. Set up `.env` and
the development services as described in the root README before running the app.

## Claude Code plugins

These recommendations target Claude Code, including its VS Code extension.
They have not been installed or enabled automatically.

| Plugin                                                                                                         | Why it fits NOVA                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [typescript-lsp](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp)       | Definitions, references, and diagnostics for the NestJS API, and shared contracts. Its listed file types do not include `.svelte`; keep using svelte-check for components. |
| [frontend-design](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/frontend-design)     | UI design help for NOVA's dashboard and settings screens. Ask it to retain SvelteKit and the existing visual style.                                                        |
| [pr-review-toolkit](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit) | Focused reviews of error handling, test coverage, and shared type design.                                                                                                  |

Start with these three. Run the following inside a Claude Code terminal session,
then choose **Install for you, in this repo only** if you want a local setup:

```text
/plugin install typescript-lsp@claude-plugins-official
/plugin install frontend-design@claude-plugins-official
/plugin install pr-review-toolkit@claude-plugins-official
```

If the official marketplace is missing, add it first:

```text
/plugin marketplace add anthropics/claude-plugins-official
```

The TypeScript plugin also needs a language-server executable on your PATH.
Its official setup command is run in your regular shell:

```sh
npm install -g typescript-language-server typescript
```

In the VS Code Claude panel, use `/plugins` to open the plugin manager instead.
Follow any activation or reload instructions and check the Installed tab.
See the [official installation and scope documentation](https://code.claude.com/docs/en/discover-plugins).

Optional: [security-guidance](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance)
is relevant when changing NOVA's SSH, browser automation, credentials, or tool
execution. It adds edit warnings and automated reviews; its model-based reviews
can add token cost and latency. Install it if that extra review is useful:

```text
/plugin install security-guidance@claude-plugins-official
```

Plugins complement NOVA's tests and its action-confirmation logic. Keep running
`npm test`, `npm run lint`, and `npm run typecheck` for changed code.
