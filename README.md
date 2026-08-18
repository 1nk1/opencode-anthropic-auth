# OpenCode Anthropic Auth Plugin

> [!WARNING]
> This plugin comes with no guarantees. You might be banned for breaking the TOS, you might not be. I don't work at Anthropic, nor am I an attorney.
>
> Use your best judgment and don't try to abuse the subscriptions. Plugins like oh-my-openagent are _known_ to trigger bans. Please be careful when using Ralph loops or insanely heavy usage patterns.

> [!IMPORTANT]
> If you are seeing issues, please try to `rm -rf ~/.cache/opencode/packages/@ex-machina` and check your `opencode.json` config to make sure you're on the latest version.
>
> Try this FIRST before making an Issue. Thanks!

An [OpenCode](https://github.com/anomalyco/opencode) plugin that provides Anthropic OAuth authentication, enabling Claude Pro/Max users to use their subscription directly with OpenCode.

## Version compatibility

| Plugin version | OpenCode version | Package                                     |
|-----------------|-------------------|---------------------------------------------|
| 2.x (this readme) | OpenCode v2 (beta plugin API) | `@ex-machina/opencode-anthropic-auth` |
| 1.x               | OpenCode v1       | `@ex-machina/opencode-anthropic-auth@1` |

OpenCode v2's plugin API is still beta, and this plugin currently targets the `@opencode-ai/plugin@0.0.0-next-17444` prerelease of it — pin the plugin version and keep an eye on the changelog when bumping either side. If you're still on OpenCode v1, keep using a `1.x` release; v1 plugins are **not** loadable by OpenCode v2, and this v2 port is not loadable by OpenCode v1.

## Usage

Add the plugin to your OpenCode configuration:

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth"]
}
```

> [!TIP]
> It is STRONGLY advised that you pin the plugin to a version. This will keep you from getting automatic updates; however, this will protect you from nefarious updates.
>
> This holds true for ANY OpenCode plugin. If you do not pin them, OpenCode will automatically update them on startup. It's a massive vulnerability waiting to happen.

#### Example of pinned version

```json
{
  "plugins": ["@ex-machina/opencode-anthropic-auth@2.0.0"]
}
```

## Authentication Methods

- **Claude Pro/Max** - OAuth flow via `claude.ai` for Pro/Max subscribers. Uses your existing subscription at no additional API cost.
    - run the `/connect` command, select `Anthropic` -> `Claude Pro/Max` and do OAuth
- **Manually enter API Key / `ANTHROPIC_API_KEY`** - Handled by OpenCode's built-in Anthropic integration, not by this plugin.

> [!NOTE]
> The v1 release of this plugin also offered a "Create an API Key" OAuth flow (via `console.anthropic.com`) that minted and stored an API key for you. OpenCode v2's plugin API does not yet support an OAuth authorization flow that ends in a stored API key, so that flow isn't available in this v2 release. Use manual API key entry (or `ANTHROPIC_API_KEY`) in the meantime — see [issue #203](https://github.com/ex-machina-co/opencode-anthropic-auth/issues/203) for status.

## Configuration

The plugin supports the following environment variables:

| Variable                          | Description                                                                                                                                                                                 |
|-----------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `ANTHROPIC_BASE_URL`              | Override the API endpoint URL (e.g. for proxying). Must be a valid HTTP(S) URL.                                                                                                             |
| `ANTHROPIC_INSECURE`              | **Not supported under OpenCode v2.** OpenCode v2 plugin request hooks can rewrite a request but cannot disable TLS verification for it. If this is set, the plugin logs a warning and leaves TLS verification enabled — requests to a self-signed/untrusted `ANTHROPIC_BASE_URL` will fail. |

## How It Works

For Claude Pro/Max authentication, the plugin:

1. Initiates a PKCE OAuth flow against Anthropic's authorization endpoint
2. Exchanges the authorization code for access and refresh tokens
3. Automatically refreshes expired tokens
4. Injects the required OAuth headers and beta flags into API requests
5. Sanitizes the system prompt for compatibility (see below)
6. Zeros out model costs (since usage is covered by the subscription)

### System Prompt Sanitization

The Anthropic API for Max subscriptions has specific requirements for the system prompt to identify as Claude Code. The plugin rewrites the system prompt on each request using an **anchor-based** approach that minimizes what gets changed:

1. **Identity swap** — The OpenCode identity line is removed and replaced with the Claude Code identity.
2. **Paragraph removal by anchor** — Any paragraph containing a known URL anchor (e.g. `github.com/anomalyco/opencode`, `opencode.ai/docs`) is removed entirely. This is resilient to upstream rewording — as long as the anchor URL appears somewhere in the paragraph, the removal works regardless of surrounding text changes.
3. **Inline text replacements** — Short branded strings inside paragraphs we want to keep are replaced (e.g. "OpenCode" → "the assistant" in the professional objectivity section).

Everything else in the system prompt is preserved: tone/style guidance, task management instructions, tool usage policy, environment info, skills, user/project instructions, and file paths containing "opencode". The sanitized system prompt is structured as three blocks in `system[]`: the billing header, the Claude Code identity line, and the remaining system content.

## Development

### Local Testing

Use `bun run dev` to test plugin changes locally without publishing to npm:

```bash
bun run dev
```

This does three things:

1. Builds the plugin
2. Symlinks the build output into `.opencode/plugins/` so OpenCode loads it as a local plugin
3. Starts `tsc --watch` for automatic rebuilds on source changes

After starting the dev script, restart OpenCode v2 (`opencode2`) in this project directory to pick up the local build. Any edits to `src/` will trigger a rebuild — restart OpenCode again to load the new version.

You can confirm the plugin loaded correctly via the OpenCode v2 API:

```bash
opencode2 api get /api/plugin        # should list "ex-machina.anthropic-auth"
opencode2 api get /api/integration   # anthropic should offer a "Claude Pro/Max" OAuth method
```

Ctrl+C stops the watcher and cleans up the symlink. If the process was killed without cleanup (e.g. `kill -9`), you can manually remove the symlink:

```bash
bun run dev:clean
```

> [!NOTE]
> If you have the npm version of this plugin in your global OpenCode config, both will load. The local version takes precedence for auth handling.

### Publishing

This project uses [changesets](https://github.com/changesets/changesets) for versioning and publishing. See the [changeset README](.changeset/README.md) for more details.

```bash
bun change          # create a changeset describing your changes
```

When changesets are merged to `main`, CI will automatically open a release PR. Merging that PR publishes to npm.

## License

MIT
