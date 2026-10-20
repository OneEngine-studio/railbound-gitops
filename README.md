# railbound-gitops

GitOps repository managing Kubernetes manifests, ArgoCD deployments, Nakama game services, and Agones infrastructure for RAILBOUND.

## Architecture

This repository follows the ArgoCD **App-of-Apps** pattern:

```text
cluster/root-app.yaml (Root Application)
├── app/root-platform-app.yaml (Platform Layer -> namespace: platform)
│   └── app/platform/root-data-app.yaml (CockroachDB Data Tier -> charts/cockroachdb)
└── app/root-services-app.yaml (Services Layer -> namespace: apps)
    └── app/services/nakama-service-app.yaml (Nakama Game Server & Manager -> charts/nakama)
```

### Directory Structure

```text
├── app/
│   ├── root-platform-app.yaml       # Syncs platform child apps into namespace 'platform'
│   ├── root-services-app.yaml       # Syncs service child apps into namespace 'apps'
│   ├── platform/
│   │   └── root-data-app.yaml       # ArgoCD Application deploying CockroachDB
│   └── services/
│       └── nakama-service-app.yaml  # ArgoCD Application deploying Nakama Game Server
├── charts/
│   ├── cockroachdb/                 # CockroachDB distributed database Helm chart
│   └── nakama/                      # Nakama Game Server & Console Manager Helm chart
└── cluster/
    └── root-app.yaml                # Main entrypoint ArgoCD application
```

## Helm Charts

### 1. Nakama Game Server & Console Manager (`charts/nakama`)
Deploys Heroic Labs Nakama game server:
- **Client Socket / HTTP API:** Port `7350`
- **gRPC API:** Port `7349`
- **Nakama Console (Server Manager):** Port `7351` (Web UI for inspecting sessions, matches, accounts, and server metrics)
- **Prometheus Metrics:** Port `9090`
- Automatic database schema migration via container startup lifecycle
- Wait-for-database initialization check

### 2. CockroachDB Data Tier (`charts/cockroachdb`)
Deploys CockroachDB as the distributed SQL data backend for Nakama:
- **SQL Port:** `26257`
- **Web Admin UI:** `8080`
- Persistent storage support via StatefulSet

## Quick Start / Local Testing

### Validate Helm Charts
```bash
helm lint charts/cockroachdb
helm lint charts/nakama
```

### Template Render Test
```bash
helm template test charts/cockroachdb
helm template test charts/nakama
```

### Port Forwarding (Local Access)
Once deployed on Kubernetes:

```bash
# Nakama Client API & WebSockets
kubectl --namespace apps port-forward svc/nakama 7350:7350

# Nakama Server Manager (Console Web UI)
kubectl --namespace apps port-forward svc/nakama 7351:7351
# Access Console at http://localhost:7351 (Default: admin / password)

# CockroachDB Admin UI
kubectl --namespace platform port-forward svc/cockroachdb 8080:8080
# Access UI at http://localhost:8080
```

## Architecture

This repository follows the ArgoCD **App-of-Apps** pattern:

```text
cluster/root-app.yaml (Root Application)
├── app/root-platform-app.yaml (Platform Layer -> namespace: platform)
│   └── app/platform/root-data-app.yaml (CockroachDB Data Tier -> charts/cockroachdb)
└── app/root-services-app.yaml (Services Layer -> namespace: apps)
    └── app/services/nakama-service-app.yaml (Nakama Game Server & Manager -> charts/nakama)
```

### Directory Structure

```text
├── app/
│   ├── root-platform-app.yaml       # Syncs platform child apps into namespace 'platform'
│   ├── root-services-app.yaml       # Syncs service child apps into namespace 'apps'
│   ├── platform/
│   │   └── root-data-app.yaml       # ArgoCD Application deploying CockroachDB
│   └── services/
│       └── nakama-service-app.yaml  # ArgoCD Application deploying Nakama Game Server
├── charts/
│   ├── cockroachdb/                 # CockroachDB distributed database Helm chart
│   └── nakama/                      # Nakama Game Server & Console Manager Helm chart
└── cluster/
    └── root-app.yaml                # Main entrypoint ArgoCD application
```

## Helm Charts

### 1. Nakama Game Server & Console Manager (`charts/nakama`)
Deploys Heroic Labs Nakama game server:
- **Client Socket / HTTP API:** Port `7350`
- **gRPC API:** Port `7349`
- **Nakama Console (Server Manager):** Port `7351` (Web UI for inspecting sessions, matches, accounts, and server metrics)
- **Prometheus Metrics:** Port `9090`
- Automatic database schema migration via container startup lifecycle
- Wait-for-database initialization check

### 2. CockroachDB Data Tier (`charts/cockroachdb`)
Deploys CockroachDB as the distributed SQL data backend for Nakama:
- **SQL Port:** `26257`
- **Web Admin UI:** `8080`
- Persistent storage support via StatefulSet

## Quick Start / Local Testing

### Validate Helm Charts
```bash
helm lint charts/cockroachdb
helm lint charts/nakama
```

### Template Render Test
```bash
helm template test charts/cockroachdb
helm template test charts/nakama
```

### Port Forwarding (Local Access)
Once deployed on Kubernetes:

```bash
# Nakama Client API & WebSockets
kubectl --namespace apps port-forward svc/nakama 7350:7350

# Nakama Server Manager (Console Web UI)
kubectl --namespace apps port-forward svc/nakama 7351:7351
# Access Console at http://localhost:7351 (Default: admin / password)

# CockroachDB Admin UI
kubectl --namespace platform port-forward svc/cockroachdb 8080:8080
# Access UI at http://localhost:8080
```

