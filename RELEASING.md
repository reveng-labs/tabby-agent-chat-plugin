# Releasing

Releases are fully automated. You bump a version locally, push a tag, and
GitHub Actions does the rest: builds the plugin, publishes the tarball to
npm, and creates a GitHub Release with auto-generated notes.

Your machine never runs `webpack`.

## One-time setup

1. Create an npm account at https://www.npmjs.com/signup (any email).
2. On npmjs.com → user menu → **Access Tokens** → **Generate New Token**:
   - Type: **Automation** (works in CI without 2FA prompts)
   - Packages and scopes: **Read and write** access to the `tabby-agent-chat`
     package (or all packages, your call)
   - Copy the token — it's shown once
3. On GitHub repo → **Settings** → **Secrets and variables** → **Actions** →
   **New repository secret**:
   - Name: `NPM_TOKEN`
   - Value: the token from step 2

## Cutting a release

```sh
npm version patch    # or minor / major / 1.2.3
git push --follow-tags
```

`npm version` bumps `package.json`, commits the change, and creates an
annotated tag like `v1.0.1`. `--follow-tags` pushes both the commit and
the tag. Pushing the tag triggers `.github/workflows/release.yml`.

Watch progress at:

    https://github.com/reveng-labs/tabby-agent-chat-plugin/actions

When green:

- New version is live at https://www.npmjs.com/package/tabby-agent-chat
- A GitHub Release is created with notes auto-generated from commits since
  the previous tag, plus `dist/index.js` attached for direct download

## End-user install on another machine

```sh
npm install -g tabby-agent-chat
```

Or via Tabby's built-in **Settings → Plugins** UI — the plugin shows up
there because `package.json` keywords include `"tabby-plugin"`, which is
how Tabby's plugin manager discovers packages on npm.

## What if I want to undo a release?

- Bad code on npm: `npm deprecate tabby-agent-chat@1.0.1 "broken, use 1.0.2"`
  (you cannot delete after 72 hours; deprecation is the right tool)
- Bad GitHub Release: delete the tag (`git push --delete origin v1.0.1` +
  delete the release in the GitHub UI), publish a fixed `v1.0.2`
