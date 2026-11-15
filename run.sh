apiVersion: v1
kind: Secret
metadata:
  name: cloudflare-tunnel-token
  namespace: apps
type: Opaque
stringData:
  token: "<YOUR_CLOUDFLARE_TUNNEL_TOKEN>"
---
apiVersion: v1
kind: Secret
metadata:
  name: registry-pull
  namespace: platform
type: <unsafe_url>kubernetes.io/dockerconfigjson</unsafe_url>
stringData:
  .dockerconfigjson: |
    {
      "auths": {
        "<unsafe_url>registry.kushanherath.me</unsafe_url>": {
          "username": "registryadmin",
          "password": "12345678",
          "auth": "cmVnaXN0cnlhZG1pbjoxMjM0NTY3OA=="
        }
      }
    }
---
apiVersion: <unsafe_url>argoproj.io/v1alpha1</unsafe_url>
kind: Application
metadata:
  name: root-apps
  namespace: argocd
  finalizers:
    - <unsafe_url>resources-finalizer.argocd.argoproj.io</unsafe_url>
spec:
  project: default
  source:
    repoURL: https://github.com/OneEngine-studio/railbound-gitops.git
    targetRevision: main
    path: app
  destination:
    server: https://kubernetes.default.svc
    namespace: argocd
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    syncOptions:
      - CreateNamespace=true
