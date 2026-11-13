# Upgrading Nakama (3.22.0 to 3.37.0)

## Why

The game client uses `nakama-unity` 3.21.1 (February 2026), which belongs to Nakama server 3.36 / 3.37. The server runs
3.22.0 (June 2024). The two have drifted apart, and it already shows: the lobby's **party** feature sends fields (`hidden`,
`label`, added to the protocol in Nakama **3.28.0**, July 2025) that Nakama 3.22.0 does not know. It answers
`Received malformed payload` and closes the socket. Everything else still works because the older messages did not change.

## What the change does

`charts/nakama/values.yaml`: image tag `3.22.0` becomes `3.37.0` (and `appVersion` in `Chart.yaml`). Nothing else.

The chart already runs `nakama migrate up` in an init container before the server starts, so the database schema is migrated by the
deployment itself. The changelog from 3.23 to 3.37 lists no removed settings; the existing `nakama-config.yml` and the JavaScript
module (`railbound_allocate`) use only features that did not change. The 3.35 line contains a fix for a console migration on
CockroachDB, which is another reason to target 3.37 rather than a version in between.

## The risk

`migrate up` changes the schema and is **not reversible by just putting the old image back**: Nakama 3.22 may not run on the
migrated schema. The way back is a restore of the backup from before the upgrade. The scheduled backup (every 6 hours) is
the safety net; take one more immediately before.

## Procedure

1. Take a fresh backup and check that it succeeded (on the master):

   ```bash
   kubectl -n platform create job --from=cronjob/cockroachdb-backup pre-nakama-upgrade
   kubectl -n platform logs job/pre-nakama-upgrade -f
   ```

   Expect `succeeded`.

2. Choose a quiet moment: players are logged out for the minute the pod restarts (guest accounts survive, they live in the database).

3. Merge the pull request. Argo CD rolls the Nakama deployment.

4. Check it:

   ```bash
   kubectl -n apps get pods
   kubectl -n apps logs deploy/nakama -c nakama --tail=30 | grep -i -E "version|error|migrat"
   curl -s -o /dev/null -w "%{http_code}\n" https://restapinakama.kushanherath.me/healthcheck
   ```

   The health check must answer 200. Then play: log in as guest, deploy, and in the lobby press F1 (party window): the code must
   appear instead of "NOT AVAILABLE YET".

## If something is wrong

1. Revert the pull request (the old tag comes back).
2. If Nakama 3.22 does not start on the migrated schema, restore the database from the backup taken in step 1:

   ```sql
   -- scale Nakama down first: kubectl -n apps scale deploy/nakama --replicas=0
   DROP DATABASE nakama CASCADE;
   RESTORE DATABASE nakama FROM LATEST IN 's3://<bucket>/cockroachdb?AUTH=implicit&AWS_REGION=ap-south-1';
   ```

   (see `docs/backup-and-restore.md`), then scale Nakama up again.

## Optional: rehearse first

The upgrade can be tried without touching the live service: deploy Nakama 3.37 with its own throw-away CockroachDB in a separate
namespace and point a test client at it. That proves the new server starts with this config and module, and accepts a party,
before the real database is migrated.
