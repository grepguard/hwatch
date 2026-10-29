# Contributing

Thanks for your interest in contributing to HWatch!

## Development setup

```sh
git clone https://github.com/grepguard/hwatch.git
cd hwatch
npm ci
```

The package requires Node.js 22.13.0 or newer. The repository's `.nvmrc` selects the maintainer development version.

## Link the CLI locally

Link this checkout so you can run the `hwatch` command while developing:

```sh
npm link
hwatch help
```

Remove the global link when you are done:

```sh
npm unlink --global hwatch
```

## Checks

- `npm run check:ci` runs Biome checks without modifying files. This is also run by GitHub Actions.
- `npm run check` runs Biome and applies safe fixes and formatting changes.
- `npm pack --dry-run` previews the files that would be included in the npm package.

## Releasing (maintainers only)

The GitHub Release and npm publication are separate steps. Pushing a semantic version tag creates a GitHub Release; maintainers publish the npm package manually.

1. Start from a clean working tree, update the version and create its commit and tag:

   ```sh
   npm version patch
   ```

   Use `minor` or `major` when appropriate. `npm version` updates both `package.json` and `package-lock.json` and creates a `vX.Y.Z` tag.

2. Push the commit and tag. The tag starts the GitHub Release workflow:

   ```sh
   git push origin main --follow-tags
   ```

3. Review the package contents and publish the new version to the public npm registry. `npm publish` runs the `prepublishOnly` Biome check first:

   ```sh
   npm pack --dry-run
   npm login
   npm publish
   ```

Publishing an unscoped package makes it public. For the first public release of a scoped package, publish with `npm publish --access public`.
