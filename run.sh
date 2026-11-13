    sudo kubectl create secret generic cloudflare-tunnel-token \
      --namespace apps \
      --from-literal=token="<YOUR_CLOUDFLARE_TUNNEL_TOKEN>"


    sudo kubectl create secret docker-registry registry-pull \
      --namespace platform \
      --docker-server=registry.kushanherath.me \
      --docker-username=registryadmin \
      --docker-password=12345678



    apiVersion: argoproj.io/v1alpha1
    kind: Application
    metadata:
      name: root-apps
      namespace: argocd
      finalizers:
        - resources-finalizer.argocd.argoproj.io
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



# Note: Agones Helm chart is now fully managed declaratively via GitOps
# (see app/platform/agones-system-app.yaml).
# You do NOT need to run any manual helm commands!
