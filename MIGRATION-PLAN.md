# Docker Compose GitOps Migration Plan

Reusable plan for moving manually managed Compose applications to GitHub and Doco-CD on one VPS. Repeat this procedure per server; keep one Doco-CD controller and one controller repository per VPS.

## Repository model

- Use one repository per deployable application.
- Prefix repositories with `app-`; reserve `tofu-` for OpenTofu repositories.
- Add GitHub Topics such as `app` and an optional service category.
- Keep application source, Compose files, deployment config, and non-secret examples in the app repository.
- Keep runtime data, certificates, database files, and real secret files on the VPS.
- Use forks when the deployment starts from an upstream repository. Keep `origin` pointed at the organization fork and `upstream` pointed at the original project.
- Do not use submodules initially. Doco-CD can deploy each app repository independently; this keeps ownership, rollback, and upstream synchronization clear.

## Secret files

Use `secrets.env` as the VPS-only file name. It is not a Doco-CD-only convention: it is an ordinary dotenv file used by the Doco-CD container and, when needed, by Compose.

- Store `/opt/doco-cd/secrets.env` only on the VPS; set mode `600`.
- Put `GIT_ACCESS_TOKEN`, `WEBHOOK_SECRET`, and app variables there.
- Set `PASS_ENV=true` on Doco-CD so app Compose interpolation receives those variables.
- Commit `secrets.env.example` with variable names and safe defaults only.
- Do not commit real `.env`, `secrets.env`, certificates, database files, or backups.
- If an app uses a service-level Compose `env_file`, handle it explicitly. Doco-CD's `PASS_ENV` supplies interpolation variables; it does not create a missing file inside the cloned repository. Either remove that `env_file` in favor of explicit environment entries, or copy the required secret file into the managed clone during cutover and document that exception.

## Repository preparation

1. Decide whether the app is production and record its current Compose project name.
2. Identify every named volume, bind mount, external network, host port, image, and service-level `env_file`.
3. Add `.gitignore` before the first commit.
4. Add `.doco-cd.yml` with the existing project name, working directory, and Compose files.
5. Add `secrets.env.example` without real values.
6. Run `docker compose config` with temporary placeholder variables; never use production secrets for validation.
7. Commit and push. Confirm `git ls-files` contains no real secret or runtime file.

## Doco-CD controller

The controller repository contains only Doco-CD's Compose file, poll configuration, examples, and operational documentation. The VPS-only `secrets.env` is ignored.

- Mount the Docker socket directly initially, or use a socket proxy with only the endpoints required for Compose deployment.
- Use a pinned Doco-CD image version; upgrade deliberately.
- Configure `POLL_CONFIG_FILE` with every app repository and `interval: 300` or longer as fallback.
- Start with `interval: 0` for an app until its first cutover is complete.
- Use GitHub webhooks as the primary trigger once the reverse proxy route works. Keep polling enabled as a fallback.
- Webhook URL: `https://<controller-host>/v1/webhook`; use HTTPS and a shared `WEBHOOK_SECRET`.
- Create a read-only GitHub token scoped to the repositories deployed by this VPS.
- Never expose Docker or SSH credentials to GitHub. GitHub only sends the signed webhook request.

## Per-app cutover

Perform one app at a time during a maintenance window.

1. Record the current state:
   - `docker compose ps`
   - `docker volume ls`
   - `docker image ls`
   - rendered Compose config with secrets redacted
   - application health and a data-level smoke test
2. Back up databases and bind-mounted data before changing anything.
3. Confirm the repository contains the exact Compose files currently in use.
4. Add the app repository to the controller poll file with `interval: 0`.
5. Enable its webhook only after the controller endpoint is reachable.
6. Trigger an initial clone/deployment. Do not delete the old app directory or volumes.
7. Stop the old Compose project with `docker compose down`; never use `down -v`.
8. Locate the Doco-CD managed clone. Copy the real `secrets.env` and every bind-mounted runtime directory into the matching working directory. Preserve ownership, permissions, and symlinks.
9. Re-run the deployment. Keep the exact Compose project `name` so existing named volumes and networks are reused.
10. Verify container names, mounts, volumes, networks, ports, health checks, logs, and application data.
11. Test restart behavior and one restore/read operation where practical.
12. Keep the old directory and backup untouched until the observation period ends.
13. Set the app poll interval to `300` and verify a test commit through webhook and fallback poll.

## Volume and data rules

- Named volumes are reused only when the Compose project and volume names remain unchanged.
- External volumes and networks must already exist on the VPS; Doco-CD should not recreate them under a new name.
- Relative bind mounts resolve below Doco-CD's managed clone, not the old checkout.
- Copy bind-mounted data before the first production deployment, not after an empty container starts.
- Never remove volumes during migration. Image pruning can be disabled during initial cutover.
- For databases, prefer a database-native dump/restore in addition to filesystem backup.
- For host paths such as Nextcloud `NEXTCLOUD_DATADIR`, verify the path is intentionally absolute and exists on the VPS; do not copy it into the Git clone.

## Rollback

1. Disable the app webhook and set its poll interval to `0`.
2. Stop the Doco-CD-managed project without removing volumes.
3. Start the previous Compose project from its preserved directory and original secret file.
4. Verify health and data.
5. Revert the repository commit only after the service is stable.
6. Do not delete the Doco-CD clone or volumes until rollback is no longer needed.

## Nextcloud AIO exception

Nextcloud AIO is not an ordinary Compose application: its mastercontainer manages child containers. Version the exact `manual-install/compose.yaml` and local production override in the organization fork, and set Doco-CD `working_dir: manual-install`. Keep `manual-install/.env` ignored. Test this migration separately after the simpler apps; verify the AIO mastercontainer volume and all child containers before enabling automatic updates.

## Multi-server reuse

For each additional VPS:

1. Create a separate Doco-CD controller deployment and host-only `secrets.env`.
2. Use an explicit server/region suffix in controller hostnames and inventory.
3. Register only that server's app repositories in its poll file.
4. Use distinct Compose project names if two servers could ever share a Docker context.
5. Configure GitHub webhook delivery to the correct server-specific URL.
6. Keep per-server backups, cutover records, rollback windows, and token scopes separate.
7. Reuse this document as the checklist; do not centralize runtime secrets or data in GitHub.
