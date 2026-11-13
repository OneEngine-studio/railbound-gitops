# CockroachDB backup and restore

The Nakama database (accounts, profiles, storage) lives in a single CockroachDB pod on a node's disk (`local-path`). If that
node is replaced or its disk is lost, the data is gone. The scheduled backup copies it to S3.

## How it works

- `charts/cockroachdb/templates/backup-cronjob.yaml`: a CronJob (every 6 hours by default) runs
  `BACKUP DATABASE nakama INTO 's3://<bucket>/cockroachdb?AUTH=implicit&AWS_REGION=<region>'`.
- No keys anywhere: the nodes carry an IAM instance profile (infra repo, `backups.tf`) that may read and write that one bucket.
- Retention: the bucket has a lifecycle rule that deletes backups after `backup_retention_days` (30).
- Only **full** backups are used. They work in the free CockroachDB build; incremental backups need an Enterprise licence.

## Turn it on (in this order)

1. Merge and apply the infra repo change that creates the bucket and the instance profile (`backups.tf`).
2. In `charts/cockroachdb/values.yaml` set `backup.enabled: true`, and in `charts/monitoring-extras/values.yaml` set
   `backupAlerts.enabled: true`. Merge.
3. Run one backup now instead of waiting for the schedule, and read it:

```bash
kubectl -n platform create job --from=cronjob/cockroachdb-backup backup-first-run
kubectl -n platform logs job/backup-first-run -f
```

   A line like `job_id | status: succeeded` means it works. If the log says the backup needs an Enterprise licence or
   cannot reach S3, send the log (a missing instance profile or the IMDS hop limit are the usual causes).
4. Check the bucket: `aws s3 ls s3://<bucket>/cockroachdb/ --recursive | head`.

## Restore

Restore into a fresh, empty database. Run these on the master:

```bash
kubectl -n platform exec -it cockroachdb-0 -- /cockroach/cockroach sql --insecure
```

```sql
-- list the backups
SHOW BACKUPS IN 's3://<bucket>/cockroachdb?AUTH=implicit&AWS_REGION=ap-south-1';

-- stop Nakama first (kubectl -n apps scale deploy/nakama --replicas=0), then:
DROP DATABASE nakama CASCADE;
RESTORE DATABASE nakama FROM LATEST IN 's3://<bucket>/cockroachdb?AUTH=implicit&AWS_REGION=ap-south-1';
```

Start Nakama again (`--replicas=1`). Practise the restore once on a copy before you depend on it.
