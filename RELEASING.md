# Releasing

Releases are fully automated. You bump a version locally, push a tag, and
GitHub Actions does the rest: builds the plugin, publishes the tarball to
npm, and creates a GitHub Release with auto-generated notes.

Your machine never runs `webpack`. Authentication to npm is via OIDC
Trusted Publishing — no long-lived tokens stored anywhere.

## One-time setup (Trusted Publishing)

1. Create an npm account at https://www.npmjs.com/signup.
2. Go to https://www.npmjs.com/new-trusted-publisher and configure:
   - **Provider:** GitHub Actions
   - **Package name:** `tabby-agent-chat`
   - **Repository owner:** `reveng-labs`
   - **Repository name:** `tabby-agent-chat-plugin`
   - **Workflow filename:** `release.yml`
   - **Environment:** leave blank
   This reserves the package name and authorizes the workflow to publish
   under it. No secrets are stored on GitHub.

That's it — no `NPM_TOKEN` to manage. Every release will also attach a
signed provenance statement (visible on the npm package page) proving the
tarball was built by this specific workflow run from this specific repo.

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
