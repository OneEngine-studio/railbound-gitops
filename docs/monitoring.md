# Monitoring

Prometheus + Alertmanager + Grafana run in the `monitoring` namespace (`app/platform/monitoring-app.yaml`, the
kube-prometheus-stack). The Railbound scrape targets, alert rules and dashboard are in `charts/monitoring-extras`.

## One-time setup (on the master)

The Grafana login is a Secret that is created by hand, so it never reaches git:

```bash
kubectl create namespace monitoring
kubectl -n monitoring create secret generic grafana-admin \
  --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -hex 16)"
kubectl -n monitoring get secret grafana-admin -o jsonpath='{.data.admin-password}' | base64 -d; echo
```

Until the Secret exists the Grafana pod waits and starts by itself afterwards.

## Open Grafana

Nothing is exposed to the internet. Use a port-forward from your PC through SSH:

```bash
ssh -i k3s-cluster.pem -L 3000:localhost:3000 ubuntu@<master-ip> "kubectl -n monitoring port-forward svc/kube-prometheus-stack-grafana 3000:80"
```

Then open http://localhost:3000, log in as `admin`, and open the dashboard **Railbound overview** (Ready servers, running
matches, autoscaler, node CPU and memory, CockroachDB).

## Alerts

| Alert | Severity | Meaning |
|---|---|---|
| `RailboundNoReadyGameServer` | critical | The fleet has had no idle server for 2 minutes: a player who presses DEPLOY waits for a new one (about 2 minutes) or gets none. |
| `RailboundFleetMetricsMissing` | critical | No fleet numbers at all: the Agones controller is down or the fleet is gone. |
| `RailboundFleetAtMaxCapacity` | warning | The autoscaler is at `maxReplicas`. |
| `RailboundAgonesTargetDown` | warning | An Agones component cannot be scraped. |
| `RailboundCockroachDown` | critical | The Nakama database is down. |
| `RailboundCockroachDiskLow` | warning | Less than 15 % free in the store. |
| `RailboundNodeMemoryHigh` | warning | A node uses more than 92 % of its memory. |
| `RailboundBackupFailed`, `RailboundBackupStale` | warning / critical | Only when `backupAlerts.enabled` is on (see backups). |

Alerts are visible right away in Prometheus (`/alerts`) and Alertmanager. To be **notified**, give Alertmanager a receiver.
Example for Discord (Alertmanager reads the webhook from a file, so the URL stays out of git):

```bash
kubectl -n monitoring create secret generic alertmanager-discord --from-literal=webhook_url='https://discord.com/api/webhooks/...'
```

then add to `app/platform/monitoring-app.yaml` under `alertmanager:` (inside the `values`):

```yaml
alertmanager:
  alertmanagerSpec:
    secrets: [alertmanager-discord]
  config:
    route:
      receiver: discord
      group_by: [alertname]
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
      routes:
        - receiver: "null"
          matchers: [alertname = "Watchdog"]
    receivers:
      - name: "null"
      - name: discord
        discord_configs:
          - webhook_url_file: /etc/alertmanager/secrets/alertmanager-discord/webhook_url
            send_resolved: true
```

Create the Secret before merging that change, because the Alertmanager pod mounts it.

## Resource use

About 1 GB of memory and 5 GB of disk for everything (retention 3 days). Prometheus and Grafana have limits, see the values in
`app/platform/monitoring-app.yaml`.
