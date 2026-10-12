# Releasing

A release is a git tag. Pushing a tag that starts with `v` runs `.github/workflows/release.yml`, which publishes the Docker image and the Windows agent.

## Version numbers

NOVA uses `vMAJOR.MINOR.PATCH`. The project is in the `v0.1.x` series: **every release bumps the PATCH number** (`v0.1.1`, `v0.1.2`, ... up to `v0.1.99`), then moves on to `v0.2.0` and starts again. Check the latest tag with `git tag | sort -V | tail -1` and take the next one.

The version that matters is the tag: the image build receives it as `NOVA_VERSION` and the running API reports it at `GET /api/nova/health`. The `version` fields in the `package.json` files are not used for releases and are not bumped.

## Cut a release

1. Make sure `main` is green (CI runs format check, lint, typecheck, tests, build, the Windows agent check and a trial image build).
2. Write and review the short update instructions in `docs/release-notes/vX.Y.Z.md` for the next tag. The release script refuses to push without that file; the GitHub release uses it as its description.
3. After explicit approval, use the release script to check the next version and push it:

   ```sh
   scripts/release.sh --dry
   scripts/release.sh --confirm vX.Y.Z
   ```

   Substitute the version printed by `--dry`. Never reuse or move a published tag. Do not tag or push without explicit approval.

4. Watch the **Release** workflow on GitHub Actions.

## What the workflow publishes

| Job      | Result                                                                                                                                                                                                             |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `image`  | A multi-architecture image (`linux/amd64`, `linux/arm64`) pushed to `ghcr.io/<owner>/nova` with the tags `X.Y.Z`, `X.Y` and `latest`. The build argument `NOVA_VERSION` is the tag name.                           |
| `agents` | A GitHub release with the reviewed version-specific notes and two attached files: `nova-windows-agent.zip` (the `agents/windows` folder without its tests) and `docker-compose.yml` (the production compose file). |

The image name uses the owner of the GitHub repository. The first time, set the package visibility in GitHub (Packages) to public if people should be able to pull it without logging in.

## Updating a server

On the server, set `NOVA_VERSION` in `.env` to the new version (without the `v`), then:

```sh
docker compose pull && docker compose up -d
```

If the Windows agent changed, replace the implementation at `jarvis-agent.ps1` through NOVA’s compatibility download, or install `nova-agent.ps1` from the release zip and run the `JarvisAgent` scheduled task again. See [Windows agent](windows-agent.md).
